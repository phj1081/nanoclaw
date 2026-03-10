import {
  Attachment,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

/**
 * Transcribe an audio attachment via OpenAI Whisper API.
 * Returns the transcribed text, or a fallback placeholder on failure.
 */
async function transcribeAudio(
  att: Attachment,
  apiKey: string,
): Promise<string> {
  try {
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const form = new FormData();
    const filename = att.name || 'audio.ogg';
    form.append('file', new Blob([buffer]), filename);
    form.append('model', 'whisper-1');

    const whisperRes = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
    );
    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      throw new Error(`Whisper API ${whisperRes.status}: ${errText}`);
    }
    const data = (await whisperRes.json()) as { text: string };
    logger.info(
      { file: filename, length: data.text.length },
      'Audio transcribed',
    );
    return `[Voice message transcription]: ${data.text}`;
  } catch (err) {
    logger.error({ err, file: att.name }, 'Audio transcription failed');
    return `[Audio: ${att.name || 'audio'} (transcription failed)]`;
  }
}
import { registerChannel, ChannelOpts } from './registry.js';
import {
  AgentType,
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private typingIntervals = new Map<string, NodeJS.Timeout>();
  private agentTypeFilter?: AgentType;

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    agentTypeFilter?: AgentType,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.agentTypeFilter = agentTypeFilter;
    if (agentTypeFilter) {
      this.name = `discord-${agentTypeFilter}`;
    }
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore own messages only
      if (message.author.id === this.client?.user?.id) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — transcribe audio, placeholder for others
      if (message.attachments.size > 0) {
        const openaiKey =
          process.env.OPENAI_API_KEY ||
          readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY ||
          '';
        const attachmentDescriptions = await Promise.all(
          [...message.attachments.values()].map(async (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('audio/') && openaiKey) {
              return transcribeAudio(att, openaiKey);
            } else if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          }),
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups matching our agent type
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }
      if (
        this.agentTypeFilter &&
        (group.agentType || 'claude-code') !== this.agentTypeFilter
      ) {
        return; // This JID belongs to a different agent type's bot
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: message.author.bot ?? false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Convert @username mentions to Discord mention format
      const mentionMap: Record<string, string> = {
        눈쟁이: '216851709744513024',
      };
      let resolved = text;
      for (const [name, id] of Object.entries(mentionMap)) {
        resolved = resolved.replace(new RegExp(`@${name}`, 'g'), `<@${id}>`);
      }

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (resolved.length <= MAX_LENGTH) {
        await textChannel.send(resolved);
      } else {
        for (let i = 0; i < resolved.length; i += MAX_LENGTH) {
          await textChannel.send(resolved.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    if (!jid.startsWith('dc:')) return false;
    if (!this.agentTypeFilter) return true;
    const group = this.opts.registeredGroups()[jid];
    if (!group) return false;
    const groupType = group.agentType || 'claude-code';
    return groupType === this.agentTypeFilter;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    // Clear any existing interval for this channel
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    const sendOnce = async () => {
      try {
        const channelId = jid.replace(/^dc:/, '');
        const channel = await this.client!.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    // Send immediately, then refresh every 8 seconds (Discord expires at ~10s)
    await sendOnce();
    this.typingIntervals.set(jid, setInterval(sendOnce, 8000));
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_CODEX_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  // If a second Codex bot token exists, this instance only handles claude-code groups
  const hasCodexBot = !!(
    process.env.DISCORD_CODEX_BOT_TOKEN || envVars.DISCORD_CODEX_BOT_TOKEN
  );
  return new DiscordChannel(
    token,
    opts,
    hasCodexBot ? 'claude-code' : undefined,
  );
});

registerChannel('discord-codex', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_CODEX_BOT_TOKEN']);
  const token =
    process.env.DISCORD_CODEX_BOT_TOKEN ||
    envVars.DISCORD_CODEX_BOT_TOKEN ||
    '';
  if (!token) return null; // Codex Discord bot is optional
  return new DiscordChannel(token, opts, 'codex');
});
