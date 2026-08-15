export class ILinkApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "ILinkApiError";
  }
}

export class SessionExpiredError extends ILinkApiError {
  constructor(message = "微信登录会话已失效，请重新扫码登录。") {
    super(message, -14);
    this.name = "SessionExpiredError";
  }
}
