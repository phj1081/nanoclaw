#!/usr/bin/env python3
import importlib.util
import io
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name('status-board.py')
spec = importlib.util.spec_from_file_location('status_board', MODULE_PATH)
assert spec is not None
status_board = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(status_board)


class CLIProxyQuotaCollectionTests(unittest.TestCase):

    def test_quota_probe_failure_is_logged_without_credential_fields(self):
        files = [{
            'name': 'secret-account@example.com-pro.json',
            'type': 'codex',
            'auth_index': 'private-auth-index',
            'status': 'active',
            'account_id': 'private-account-id',
        }]

        def fake_fetch(path, _payload=None):
            if path == '/auth-files':
                return {'files': files}
            return {'status_code': 401, 'body': '{"error":"token_expired"}'}

        stderr = io.StringIO()
        with mock.patch('sys.stderr', stderr):
            status_board.collect_cliproxy_quota_rows([], fetch=fake_fetch)

        logged = stderr.getvalue()
        self.assertIn(
            'cliproxy quota probe failed: provider=codex account=1 '
            'error=RuntimeError detail=upstream HTTP 401',
            logged,
        )
        self.assertNotIn('secret-account', logged)
        self.assertNotIn('private-auth-index', logged)
        self.assertNotIn('private-account-id', logged)

    def test_build_content_does_not_repeat_quota_threshold_warning(self):
        claude_rows = [('Claude1', 100, 'c5', 40, 'c7', None)]
        codex_rows = [('Codex1 team', -1, '', 100, 1234, None)]

        def fake_collect(warnings):
            warnings.extend(['Claude1 5h 100%', 'Codex1 7d 100%'])
            return claude_rows, codex_rows

        with (
            mock.patch.object(
                status_board,
                'collect_quota_rows',
                side_effect=fake_collect,
            ),
            mock.patch.object(status_board, 'collect_grok_rows', return_value=[]),
            mock.patch.object(status_board, 'agent_status_line', return_value=None),
            mock.patch.object(status_board, 'server_block', return_value=None),
        ):
            content = status_board.build_content()

        self.assertIn('100%', content)
        self.assertNotIn('⚠️', content)

    def test_collects_and_renders_grok_inspection_status_labels(self):
        payload = {
            'finished_at': '2026-07-15T06:48:28+09:00',
            'results': [
                {
                    'email': 'a@example.com',
                    'classification': 'healthy',
                    'model': 'grok-4.5',
                    'error_message': json.dumps({'model': 'grok-4.5-build-free'}),
                },
                {
                    'email': 'b@example.com',
                    'classification': 'quota_exhausted',
                    'model': 'grok-4.5',
                    'error_message': json.dumps({'model': 'grok-4.5-build'}),
                },
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'results.json'
            path.write_text(json.dumps(payload))
            finished = status_board._grok_finished_unix(payload, path)
            rows = status_board.collect_grok_rows(
                result_path=path,
                auth_dir=pathlib.Path(directory) / 'no-auth',
                now=lambda: finished + 600,
            )
            lines = status_board.render_grok_table(rows)

        self.assertEqual(rows[0][0], 'Grok1')
        self.assertEqual(rows[0][1], 'ok')
        self.assertEqual(rows[0][2], 'build-free')
        self.assertEqual(rows[0][3], 10)
        self.assertEqual(rows[1][1], '한도소진')
        self.assertEqual(rows[1][2], 'build')
        text = '\n'.join(lines)
        self.assertIn('Grok1', text)
        self.assertIn('한도소진', text)
        self.assertIn('build-free', text)
        # 10분: 표기 안 함 / 75분: 표기
        self.assertNotIn('(10m)', text)
        old_rows = [(r[0], r[1], r[2], 75, r[4]) for r in rows]
        old_text = '\n'.join(status_board.render_grok_table(old_rows))
        self.assertIn('(75m)', old_text)
        self.assertNotIn('SuperGrok', text)
        self.assertNotIn('Premium', text)

    def test_grok_rows_live_in_same_usage_table_fence(self):
        claude = [('Claude1', 10, '', 20, '', None)]
        codex = [('Codex1 pro', -1, '', 5, 1, None)]
        grok = [('Grok1', 'ok', 'build', 0, 'healthy')]
        lines = status_board.render_usage_table(claude, codex, grok)
        text = '\n'.join(lines)
        self.assertEqual(text.count('```'), 2)
        self.assertLess(text.index('Claude1'), text.index('Codex1'))
        self.assertLess(text.index('Codex1'), text.index('Grok1'))
        self.assertIn('5h', text)
        self.assertIn('ok', text)

    def test_build_content_includes_grok_block(self):
        with (
            mock.patch.object(
                status_board,
                'collect_quota_rows',
                return_value=([('Claude1', 1, '', 2, '', None)], []),
            ),
            mock.patch.object(
                status_board,
                'collect_grok_rows',
                return_value=[('Grok1', 'ok', 'build', 0, 'healthy')],
            ),
            mock.patch.object(status_board, 'agent_status_line', return_value=None),
            mock.patch.object(status_board, 'server_block', return_value=None),
        ):
            content = status_board.build_content()
        self.assertIn('Grok1', content)
        self.assertIn('ok', content)

    def test_collects_all_quota_capable_accounts_via_management_api(self):
        files = [
            {
                'name': 'claude-onecli-direct.json',
                'type': 'claude',
                'auth_index': 'claude-direct',
                'status': 'active',
                'label': 'onecli-direct@local',
            },
            {
                'name': 'codex-team.json',
                'type': 'codex',
                'auth_index': 'codex-team',
                # Exhausted accounts are status=error but quota must still show 100%.
                'status': 'error',
                'account_id': 'team-account',
            },
            {
                'name': 'claude-a.json',
                'type': 'claude',
                'auth_index': 'claude-a',
                'status': 'active',
            },
            {
                'name': 'codex-pro.json',
                'type': 'codex',
                'auth_index': 'codex-pro',
                'status': 'active',
                'account_id': 'pro-account',
            },
            {
                'name': 'claude-b.json',
                'type': 'claude',
                'auth_index': 'claude-b',
                'status': 'active',
            },
        ]
        responses = {
            'claude-direct': {
                'status_code': 403,
                'body': json.dumps({'error': {'type': 'permission_error'}}),
            },
            'claude-a': {
                'status_code': 200,
                'body': json.dumps({
                    'five_hour': {'utilization': 1.0, 'resets_at': '2026-07-15T05:00:00Z'},
                    'seven_day': {'utilization': 40.0, 'resets_at': '2026-07-18T05:00:00Z'},
                }),
            },
            'claude-b': {
                'status_code': 200,
                'body': json.dumps({
                    'limits': [
                        {'kind': 'session', 'percent': 3, 'resets_at': '2026-07-15T06:00:00Z'},
                        {'kind': 'weekly_all', 'percent': 9, 'resets_at': '2026-07-20T06:00:00Z'},
                    ]
                }),
            },
            'codex-pro': {
                'status_code': 200,
                'body': json.dumps({
                    'plan_type': 'pro',
                    'rate_limit': {
                        'primary_window': {
                            'used_percent': 5,
                            'limit_window_seconds': 604800,
                            'reset_at': 1784563197,
                        }
                    },
                }),
            },
            'codex-team': {
                'status_code': 200,
                'body': json.dumps({
                    'plan_type': 'team',
                    'rate_limit': {
                        'primary_window': {
                            'used_percent': 7,
                            'limit_window_seconds': 18000,
                            'reset_at': 1784560000,
                        },
                        'secondary_window': {
                            'used_percent': 100,
                            'limit_window_seconds': 604800,
                            'reset_at': 1784990000,
                        },
                    },
                }),
            },
        }
        calls = []

        def fake_fetch(path, payload=None):
            if path == '/auth-files':
                return {'files': files}
            self.assertEqual(path, '/api-call')
            self.assertIsNotNone(payload)
            assert payload is not None
            calls.append(payload)
            return responses[payload['auth_index']]

        warnings = []
        claude_rows, codex_rows = status_board.collect_cliproxy_quota_rows(
            warnings, fetch=fake_fetch
        )

        self.assertEqual(
            claude_rows,
            [
                ('Claude1', 1, '2026-07-15T05:00:00Z', 40, '2026-07-18T05:00:00Z', None),
                ('Claude2', 3, '2026-07-15T06:00:00Z', 9, '2026-07-20T06:00:00Z', None),
            ],
        )
        self.assertEqual(
            codex_rows,
            [
                ('Codex1 pro', -1, '', 5, 1784563197, None),
                ('Codex2 team', 7, 1784560000, 100, 1784990000, None),
            ],
        )
        self.assertIn('Codex2 7d 100%', warnings)
        self.assertEqual(len(calls), 4)
        codex_calls = [call for call in calls if 'chatgpt.com' in call['url']]
        self.assertEqual(
            [call['header']['Chatgpt-Account-Id'] for call in codex_calls],
            ['pro-account', 'team-account'],
        )

    def test_falls_back_to_safe_stale_cache_when_management_api_is_down(self):
        cache = {
            'at': 1000,
            'claude_rows': [['Claude1', 80, 'c5', 40, 'c7', None]],
            'codex_rows': [['Codex1 pro', -1, '', 90, 1234, None]],
        }
        with tempfile.TemporaryDirectory() as directory:
            cache_path = pathlib.Path(directory) / 'quota.json'
            cache_path.write_text(json.dumps(cache))

            def broken_fetch(_path, _payload=None):
                raise OSError('proxy unavailable')

            warnings = []
            claude_rows, codex_rows = status_board.collect_quota_rows(
                warnings,
                fetch=broken_fetch,
                cache_path=cache_path,
                now=lambda: 1600,
            )

        self.assertEqual(claude_rows[0][-1], 10)
        self.assertEqual(codex_rows[0][-1], 10)
        self.assertIn('Claude1 5h 80%', warnings)
        self.assertIn('Codex1 7d 90%', warnings)

    def test_live_cache_contains_only_rendered_quota_rows(self):
        def fake_fetch(path, payload=None):
            if path == '/auth-files':
                return {
                    'files': [{
                        'name': 'private-email@example.com.json',
                        'type': 'claude',
                        'auth_index': 'private-auth-index',
                        'status': 'active',
                        'access_token': 'private-token',
                    }]
                }
            return {
                'status_code': 200,
                'body': json.dumps({
                    'five_hour': {'utilization': 2, 'resets_at': 'five'},
                    'seven_day': {'utilization': 4, 'resets_at': 'seven'},
                }),
            }

        with tempfile.TemporaryDirectory() as directory:
            cache_path = pathlib.Path(directory) / 'quota.json'
            status_board.collect_quota_rows(
                [], fetch=fake_fetch, cache_path=cache_path, now=lambda: 2000
            )
            cached = cache_path.read_text()

        self.assertNotIn('private-email', cached)
        self.assertNotIn('private-auth-index', cached)
        self.assertNotIn('private-token', cached)
        self.assertIn('Claude1', cached)

    def test_one_account_failure_uses_only_that_accounts_cached_row(self):
        files = [
            {'name': 'claude-a.json', 'type': 'claude', 'auth_index': 'ca', 'status': 'active'},
            {'name': 'claude-b.json', 'type': 'claude', 'auth_index': 'cb', 'status': 'active'},
            {'name': 'codex-a-pro.json', 'type': 'codex', 'auth_index': 'gx', 'status': 'active', 'account_id': 'account'},
        ]
        responses = {
            'ca': {
                'status_code': 200,
                'body': json.dumps({
                    'five_hour': {'utilization': 10, 'resets_at': 'live-c5'},
                    'seven_day': {'utilization': 20, 'resets_at': 'live-c7'},
                }),
            },
            'cb': {'status_code': 500, 'body': '{}'},
            'gx': {
                'status_code': 200,
                'body': json.dumps({
                    'plan_type': 'pro',
                    'rate_limit': {'primary_window': {
                        'used_percent': 5,
                        'limit_window_seconds': 604800,
                        'reset_at': 9999,
                    }},
                }),
            },
        }

        def fake_fetch(path, payload=None):
            if path == '/auth-files':
                return {'files': files}
            assert payload is not None
            return responses[payload['auth_index']]

        cache = {
            'at': 1000,
            'claude_rows': [
                ['Claude1', 1, 'old-a5', 2, 'old-a7', None],
                ['Claude2', 80, 'old-b5', 40, 'old-b7', None],
            ],
            'codex_rows': [['Codex1 pro', -1, '', 2, 8888, None]],
        }
        with tempfile.TemporaryDirectory() as directory:
            cache_path = pathlib.Path(directory) / 'quota.json'
            cache_path.write_text(json.dumps(cache))
            warnings = []
            claude_rows, codex_rows = status_board.collect_quota_rows(
                warnings, fetch=fake_fetch, cache_path=cache_path, now=lambda: 1600
            )
            cache_after = json.loads(cache_path.read_text())

        self.assertEqual(claude_rows[0], ('Claude1', 10, 'live-c5', 20, 'live-c7', None))
        self.assertEqual(claude_rows[1], ('Claude2', 80, 'old-b5', 40, 'old-b7', 10))
        self.assertEqual(codex_rows[0], ('Codex1 pro', -1, '', 5, 9999, None))
        self.assertEqual(cache_after['at'], 1000)
        self.assertIn('Claude2 5h 80%', warnings)




class CompactResetTests(unittest.TestCase):
    def test_compact_reset_minutes_include_unit(self):
        now = status_board.datetime.datetime.now(status_board.datetime.timezone.utc)
        # int floor can drop ~1m near boundary; use mid-window targets
        in_12m = int((now + status_board.datetime.timedelta(minutes=12, seconds=30)).timestamp())
        in_3h2 = int((now + status_board.datetime.timedelta(hours=3, minutes=2, seconds=30)).timestamp())
        in_2d5h = int((now + status_board.datetime.timedelta(days=2, hours=5, minutes=30)).timestamp())
        self.assertEqual(status_board.compact_reset(in_12m), '12m')
        self.assertEqual(status_board.compact_reset(in_3h2), '3h02')
        self.assertEqual(status_board.compact_reset(in_2d5h), '2d5h')


class GrokCreditsTests(unittest.TestCase):
    # Real CPA probe sample (account A ~3%, period end 2026-07-15T00:00:00Z)
    SAMPLE_A = bytes.fromhex(
        '000000003e'
        '0a3c0d0000404012001a0022060880a6b6d2062a0608809bdbd2063a07080115000040404212080212060880a6b6d2061a0608809bdbd206580162006801'
        '800000000f677270632d7374617475733a300d0a'
    )
    SAMPLE_B = bytes.fromhex(
        '0000000056'
        '0a540d0000c84212001a00220c08fefdbdd20610d09995e1022a0c08fef2e2d20610d09995e1023a070801150000c842421e0802120c08fefdbdd20610d09995e1021a0c08fef2e2d20610d09995e102580162006801'
        '800000000f677270632d7374617475733a300d0a'
    )

    def test_parse_grok_credits_protobuf_percent_and_reset(self):
        a = status_board.parse_grok_credits_protobuf(self.SAMPLE_A)
        self.assertEqual(a['used_percent'], 3)
        self.assertEqual(a['resets_at'], 1784073600)
        b = status_board.parse_grok_credits_protobuf(self.SAMPLE_B)
        self.assertEqual(b['used_percent'], 100)
        self.assertEqual(b['resets_at'], 1784199550)

    def test_collect_grok_credit_rows_renders_weekly_bar(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'xai-a.json').write_text(json.dumps({
                'type': 'xai', 'disabled': False, 'email': 'a@example.com',
                'access_token': 'token-a',
            }))
            (root / 'xai-b.json').write_text(json.dumps({
                'type': 'xai', 'disabled': False, 'email': 'b@example.com',
                'access_token': 'token-b',
            }))
            cache = root / 'cache.json'

            def probe(token, url=None, opener=None):
                if token == 'token-a':
                    return {'used_percent': 3, 'resets_at': 1784073600}
                if token == 'token-b':
                    return {'used_percent': 100, 'resets_at': 1784199550}
                raise RuntimeError('unknown')

            rows = status_board.collect_grok_credit_rows(
                auth_dir=root, probe=probe, cache_path=cache, now=lambda: 1_000_000)
            self.assertTrue(status_board._is_grok_credit_row(rows[0]))
            self.assertEqual(rows[0][0], 'Grok1')
            self.assertEqual(rows[0][3], 3)
            self.assertEqual(rows[1][3], 100)
            lines = status_board.render_usage_table([], [], rows)
            text = '\n'.join(lines)
            self.assertIn('3%', text)
            self.assertIn('100%', text)
            self.assertIn('7d', text)
            # credit path should not print inspection labels
            self.assertNotIn('한도소진', text)

    def test_collect_grok_rows_prefers_credits_over_inspection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'xai-a.json').write_text(json.dumps({
                'type': 'xai', 'access_token': 'token-a', 'disabled': False,
            }))
            results = root / 'results.json'
            results.write_text(json.dumps({
                'finished_at': '2026-07-15T06:48:28+09:00',
                'results': [{'classification': 'healthy', 'model': 'grok-4.5'}],
            }))
            rows = status_board.collect_grok_rows(
                result_path=results,
                auth_dir=root,
                now=lambda: 1_000_000,
                probe=lambda token, url=None, opener=None: {
                    'used_percent': 12, 'resets_at': 1784073600},
            )
            self.assertEqual(rows[0][3], 12)
            self.assertTrue(status_board._is_grok_credit_row(rows[0]))


class NativeAgentStatusTests(unittest.TestCase):
    def _fixture(self, jobs):
        directory = tempfile.TemporaryDirectory()
        root = pathlib.Path(directory.name)
        state = root / 'state.sqlite'
        connection = sqlite3.connect(state)
        connection.execute('CREATE TABLE jobs (status TEXT, heartbeat_at TEXT)')
        connection.executemany(
            'INSERT INTO jobs(status, heartbeat_at) VALUES (?, ?)', jobs)
        connection.commit()
        connection.close()
        routes = root / 'routes.json'
        routes.write_text(json.dumps({
            'routes': [
                {'id': 'native-pilot'},
                {'id': 'crawler'},
                {'id': 'portal'},
            ]
        }))
        return directory, state, routes

    def test_idle_native_runtime_does_not_count_docker_containers(self):
        fixture, state, routes = self._fixture([('completed', None)])
        try:
            line = status_board.agent_status_line(
                native_state=state,
                native_routes=routes,
                service_active=True,
                now=lambda: 1000,
            )
        finally:
            fixture.cleanup()

        self.assertEqual(line, '📊 **에이전트 상태** — 대기 / 2')
        self.assertNotIn('활성', line)

    def test_reports_running_queue_delivery_and_stalled_from_native_state(self):
        fixture, state, routes = self._fixture([
            ('running', '1970-01-01T00:15:00+00:00'),
            ('running', '1970-01-01T00:16:30+00:00'),
            ('queued', None),
            ('delivering', None),
        ])
        try:
            line = status_board.agent_status_line(
                native_state=state,
                native_routes=routes,
                service_active=True,
                now=lambda: 1000,
            )
        finally:
            fixture.cleanup()

        self.assertEqual(
            line,
            '🔴 **에이전트 상태** — 실행 2 · 대기 1 · 전달 1 · 정체 1 / 2',
        )

    def test_reports_runtime_offline_without_falling_back_to_docker(self):
        fixture, state, routes = self._fixture([])
        try:
            line = status_board.agent_status_line(
                native_state=state,
                native_routes=routes,
                service_active=False,
            )
        finally:
            fixture.cleanup()

        self.assertEqual(line, '🔴 **에이전트 상태** — runtime 중단 / 2')


if __name__ == '__main__':
    unittest.main()
