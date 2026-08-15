import type { Credential, QrStatus } from "./types.js";
import { ILinkApiClient } from "./api-client.js";
import { StateStore } from "./storage.js";

export interface QrLoginOptions {
  botType?: string;
  timeoutMs?: number;
  maxQrRefreshes?: number;
  onQrCode: (url: string) => Promise<void> | void;
  onStatus?: (status: QrStatus) => Promise<void> | void;
  requestVerificationCode?: () => Promise<string>;
}

export class QrLogin {
  constructor(
    private readonly api: ILinkApiClient,
    private readonly store: StateStore,
  ) {}

  async login(options: QrLoginOptions): Promise<Credential> {
    const existing = await this.store.loadCredential();
    const localTokenList = existing?.token ? [existing.token] : [];
    const timeoutMs = Math.max(options.timeoutMs ?? 8 * 60_000, 1_000);
    const maxRefreshes = Math.max(options.maxQrRefreshes ?? 3, 1);
    const deadline = Date.now() + timeoutMs;
    let pollBaseUrl = "https://ilinkai.weixin.qq.com";
    let pendingVerificationCode: string | undefined;

    for (let attempt = 1; attempt <= maxRefreshes; attempt += 1) {
      const qr = await this.api.getQrCode({
        ...(options.botType ? { botType: options.botType } : {}),
        localTokenList,
      });
      if (!qr.qrcode || !qr.qrcode_img_content) {
        throw new Error("微信服务没有返回有效的登录二维码。");
      }
      await options.onQrCode(qr.qrcode_img_content);

      while (Date.now() < deadline) {
        let status;
        try {
          status = await this.api.getQrStatus({
            qrcode: qr.qrcode,
            baseUrl: pollBaseUrl,
            ...(pendingVerificationCode
              ? { verifyCode: pendingVerificationCode }
              : {}),
          });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            continue;
          }
          throw error;
        }
        await options.onStatus?.(status.status);

        switch (status.status) {
          case "wait":
          case "scaned":
            break;
          case "scaned_but_redirect":
            if (status.redirect_host) {
              pollBaseUrl = `https://${status.redirect_host}`;
            }
            break;
          case "need_verifycode":
            if (!options.requestVerificationCode) {
              throw new Error("本次登录需要输入手机微信显示的验证码。");
            }
            pendingVerificationCode =
              (await options.requestVerificationCode()).trim();
            break;
          case "verify_code_blocked":
            pendingVerificationCode = undefined;
            break;
          case "expired":
            break;
          case "binded_redirect":
            if (existing) return existing;
            throw new Error(
              "该微信已绑定，但本机没有可复用的凭证。请先在旧实例解绑后重试。",
            );
          case "confirmed": {
            if (!status.bot_token || !status.ilink_bot_id) {
              throw new Error("微信已确认授权，但没有返回完整登录凭证。");
            }
            const credential: Credential = {
              accountId: status.ilink_bot_id,
              token: status.bot_token,
              baseUrl:
                status.baseurl?.trim() || "https://ilinkai.weixin.qq.com",
              ...(status.ilink_user_id
                ? { userId: status.ilink_user_id }
                : {}),
              savedAt: new Date().toISOString(),
            };
            await this.store.saveCredential(credential);
            return credential;
          }
          default: {
            const exhaustive: never = status.status;
            throw new Error(`未知二维码状态：${String(exhaustive)}`);
          }
        }

        if (
          status.status === "expired" ||
          status.status === "verify_code_blocked"
        ) {
          break;
        }
        await delay(1_000);
      }
    }

    throw new Error("二维码登录超时或多次失效，请重新运行登录命令。");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
