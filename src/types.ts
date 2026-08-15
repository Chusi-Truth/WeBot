export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface BaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

export interface TextItem {
  text?: string;
}

export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface ImageItem {
  media?: CdnMedia;
  thumb_media?: CdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CdnMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  ref_msg?: {
    title?: string;
    message_item?: MessageItem;
  };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface GetUploadUrlResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

export interface GetConfigResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface SendTypingResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface Credential {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  savedAt: string;
}

export interface IncomingTextMessage {
  messageId?: number;
  senderId: string;
  sessionId?: string;
  text: string;
  /** Bounded textual observations produced from images attached this turn. */
  imageObservations?: readonly IncomingImageObservation[];
  contextToken: string;
  createdAt?: number;
  raw: WeixinMessage;
}

export type SupportedImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export interface IncomingImageObservation {
  description: string;
  mimeType: SupportedImageMimeType;
}

export interface ImageAnalysisRequest {
  userId: string;
  userPrompt?: string;
  images: readonly {
    data: Buffer;
    mimeType: SupportedImageMimeType;
  }[];
}

export type ImageAnalyzer = (
  request: ImageAnalysisRequest,
) => Promise<string>;

export interface GeneratedImageAttachment {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  prompt: string;
  revisedPrompt?: string;
}

export interface IncomingContext {
  senderId: string;
  contextToken: string;
  messageId?: number;
  createdAt?: number;
  raw: WeixinMessage;
}

export interface VoiceTranscriptionRequest {
  audio: Buffer;
  mimeType: "audio/wav";
  filename: string;
  language?: string;
}

export type VoiceTranscriber = (
  request: VoiceTranscriptionRequest,
) => Promise<string>;

export interface OutgoingTextReplyPart {
  type: "text";
  text: string;
}

export interface OutgoingImageReplyPart {
  type: "image";
  sourceUrl: string;
  fallbackText?: string;
}

export interface OutgoingGeneratedImageReplyPart {
  type: "generated_image";
  data: Buffer;
  mimeType: GeneratedImageAttachment["mimeType"];
  /** A short description saved to memory after successful delivery. */
  memoryText: string;
  fallbackText?: string;
}

export type OutgoingReplyPart =
  | OutgoingTextReplyPart
  | OutgoingImageReplyPart
  | OutgoingGeneratedImageReplyPart;

export interface OutgoingReplyEnvelope {
  parts: readonly OutgoingReplyPart[];
  /**
   * Called by the channel after delivery so memory reflects what the user
   * actually received instead of the model's pre-delivery intent.
   */
  finalizeDelivery?: (
    deliveredMemoryReplies: readonly string[],
  ) => Promise<void>;
}

export type MessageReply =
  | string
  | readonly string[]
  | readonly OutgoingReplyPart[]
  | OutgoingReplyEnvelope
  | void;

export type MessageHandler = (
  message: IncomingTextMessage,
) => Promise<MessageReply> | MessageReply;

export type IncomingContextHandler = (
  context: IncomingContext,
) => Promise<void> | void;
