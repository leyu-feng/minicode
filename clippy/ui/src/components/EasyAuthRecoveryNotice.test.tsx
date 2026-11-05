// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEasyAuthFetchRecovery, startEasyAuthSessionChecks } from "@/lib/easy-auth-fetch";
import { hasBlockingShortcutDialog } from "@/lib/keyboardShortcuts";
import { EasyAuthRecoveryNotice } from "./EasyAuthRecoveryNotice";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("Easy Auth tab restore and blocking sign-in", () => {
  it("blocks interaction on renewal failure without unmounting the page, then unlocks after session recovery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    window.history.replaceState({}, "", "/ORG/tasks/test?tab=edit#draft");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const rawFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ session: { id: "restored" } }));
    const recovery = createEasyAuthFetchRecovery({
      fetch: rawFetch, origin: window.location.origin, isEnabled: () => true,
    });
    const stop = startEasyAuthSessionChecks(recovery, () => true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      flushSync(() => root.render(
        <>
          <textarea aria-label="Draft" defaultValue="Unsaved draft" />
          <EasyAuthRecoveryNotice recovery={recovery} />
        </>,
      ));
      const editor = container.querySelector("textarea")!;
      editor.value = "Keep my unsaved changes";
      editor.focus();
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(rawFetch).not.toHaveBeenCalled();

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => {
        flushSync(() => {});
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Sign in again");
      });
      expect((rawFetch.mock.calls[0][0] as Request).url).toBe(`${window.location.origin}/api/auth/get-session`);
      expect(rawFetch.mock.calls[1][0]).toBe(`${window.location.origin}/.auth/refresh`);
      const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      const signIn = dialog.querySelector("a")!;
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(hasBlockingShortcutDialog()).toBe(true);
      expect(signIn.getAttribute("href")).toBe(
        `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent("/ORG/tasks/test?tab=edit#draft")}`,
      );
      expect(document.activeElement).toBe(signIn);
      expect(document.body.style.pointerEvents).toBe("none");
      expect(container.getAttribute("aria-hidden")).toBe("true");
      expect(dialog.querySelector("button")).toBeNull();
      expect(container.querySelector("textarea")).toBe(editor);
      expect(editor.value).toBe("Keep my unsaved changes");
      expect(window.location.pathname).toBe("/ORG/tasks/test");

      const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      flushSync(() => signIn.dispatchEvent(escape));
      expect(escape.defaultPrevented).toBe(true);
      expect(document.querySelector('[role="alertdialog"]')).toBe(dialog);
      const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]')!;
      expect(overlay.className).toContain("fixed inset-0");
      flushSync(() => {
        overlay.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        overlay.click();
      });
      expect(document.querySelector('[role="alertdialog"]')).toBe(dialog);
      editor.focus();
      expect(document.activeElement).toBe(signIn);
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      signIn.dispatchEvent(tab);
      expect(document.activeElement).toBe(signIn);
      const shortcut = vi.fn();
      window.addEventListener("keydown", shortcut);
      try {
        signIn.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
        expect(shortcut).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("keydown", shortcut);
      }

      await recovery.fetch("/api/auth/get-session");
      await vi.waitFor(() => {
        flushSync(() => {});
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
        expect(hasBlockingShortcutDialog()).toBe(false);
        expect(document.body.style.pointerEvents).not.toBe("none");
        expect(container.hasAttribute("aria-hidden")).toBe(false);
      });
      expect(container.querySelector("textarea")).toBe(editor);
      expect(editor.value).toBe("Keep my unsaved changes");
    } finally {
      stop();
      flushSync(() => root.unmount());
      container.remove();
    }
  });
});
