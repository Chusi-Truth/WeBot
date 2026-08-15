const loginForm = document.querySelector("#login-form");
const setupForm = document.querySelector("#setup-form");
const title = document.querySelector("#login-title");
const intro = document.querySelector("#login-intro");
const message = document.querySelector("#login-message");

document.addEventListener("DOMContentLoaded", () => void initialize());

async function initialize() {
  try {
    const response = await fetch("/api/auth/status");
    const status = await response.json();
    if (status.authenticated && !status.setupRequired) {
      location.replace("/admin");
      return;
    }
    if (status.authenticated && status.setupRequired) {
      title.textContent = "设置管理密码";
      intro.textContent = "以后直接输入密码登录，不再需要复制管理令牌。";
      setupForm.hidden = false;
      document.querySelector("#setup-password").focus();
      return;
    }
    loginForm.hidden = false;
  } catch {
    showMessage("无法连接管理服务，请刷新后重试。");
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = new FormData(loginForm).get("password");
  await submit("/api/auth/login", { password }, loginForm);
});

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(setupForm);
  const password = data.get("password");
  if (password !== data.get("confirmation")) {
    showMessage("两次输入的密码不一致。");
    return;
  }
  await submit("/api/auth/password", { password }, setupForm);
});

async function submit(url, body, form) {
  const button = form.querySelector("button");
  button.disabled = true;
  message.textContent = "";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WeBot-Request": "admin",
      },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "登录失败。");
    location.replace("/admin");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "登录失败。");
  } finally {
    button.disabled = false;
  }
}

function showMessage(value) {
  message.textContent = value;
  message.setAttribute("role", "alert");
}
