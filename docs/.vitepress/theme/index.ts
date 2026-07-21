import DefaultTheme from "vitepress/theme";
import "./custom.css";
import { onMounted } from "vue";

export default {
  extends: DefaultTheme,
  setup() {
    onMounted(() => {
      const consent = localStorage.getItem("aidimag-cookie-consent");
      if (!consent) {
        showCookieBanner();
      } else if (consent === "accepted") {
        enableAnalytics();
      }
    });
  },
};

function showCookieBanner() {
  const banner = document.createElement("div");
  banner.id = "cookie-consent-banner";
  banner.innerHTML = `
    <div style="position: fixed; bottom: 0; left: 0; right: 0; background: hsl(222 47% 8%); border-top: 1px solid hsl(217 33% 16%); padding: 1rem 1.5rem; z-index: 9999; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; box-shadow: 0 -4px 24px rgba(0,0,0,0.3);">
      <div style="flex: 1; min-width: 250px;">
        <p style="margin: 0; color: hsl(210 40% 98%); font-size: 0.9375rem; line-height: 1.5;">
          We use cookies to improve your experience and analyze site traffic. By clicking "Accept", you consent to our use of cookies.
          <a href="/privacy" style="color: #60a5fa; text-decoration: underline; margin-left: 0.25rem;">Learn more</a>
        </p>
      </div>
      <div style="display: flex; gap: 0.75rem; flex-shrink: 0;">
        <button id="cookie-decline" style="padding: 0.5rem 1rem; border-radius: 0.5rem; border: 1px solid hsl(217 33% 16%); background: transparent; color: hsl(215 20% 65%); font-weight: 500; cursor: pointer; font-size: 0.875rem; transition: all 0.15s;">
          Decline
        </button>
        <button id="cookie-accept" style="padding: 0.5rem 1.25rem; border-radius: 0.5rem; border: none; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; font-size: 0.875rem; transition: all 0.15s; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);">
          Accept
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);

  document.getElementById("cookie-accept")?.addEventListener("click", () => {
    localStorage.setItem("aidimag-cookie-consent", "accepted");
    enableAnalytics();
    banner.remove();
  });

  document.getElementById("cookie-decline")?.addEventListener("click", () => {
    localStorage.setItem("aidimag-cookie-consent", "declined");
    banner.remove();
  });

  const acceptBtn = document.getElementById("cookie-accept");
  const declineBtn = document.getElementById("cookie-decline");
  
  acceptBtn?.addEventListener("mouseenter", () => {
    acceptBtn.style.background = "#1d4ed8";
  });
  acceptBtn?.addEventListener("mouseleave", () => {
    acceptBtn.style.background = "#2563eb";
  });

  declineBtn?.addEventListener("mouseenter", () => {
    declineBtn.style.borderColor = "hsl(217 33% 25%)";
    declineBtn.style.color = "hsl(210 40% 98%)";
  });
  declineBtn?.addEventListener("mouseleave", () => {
    declineBtn.style.borderColor = "hsl(217 33% 16%)";
    declineBtn.style.color = "hsl(215 20% 65%)";
  });
}

function enableAnalytics() {
  if (typeof gtag !== "undefined") {
    gtag("consent", "update", {
      analytics_storage: "granted",
    });
  }
}

