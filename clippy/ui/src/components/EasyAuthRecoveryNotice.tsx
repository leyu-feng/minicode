import { useRef, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { EasyAuthFetchRecovery } from "@/lib/easy-auth-fetch";

export function EasyAuthRecoveryNotice({ recovery }: { recovery: EasyAuthFetchRecovery }) {
  const needsSignIn = useSyncExternalStore(recovery.subscribe, recovery.getSnapshot);
  const signInLink = useRef<HTMLAnchorElement>(null);
  if (!needsSignIn) return null;
  const returnTo = window.location.pathname + window.location.search + window.location.hash;
  return (
    <AlertDialog open={needsSignIn}>
      <AlertDialogContent
        aria-modal="true"
        className="z-(--z-9999)"
        overlayClassName="z-(--z-9999)"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          signInLink.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Sign-in required</AlertDialogTitle>
          <AlertDialogDescription>
            Your sign-in session could not be refreshed. Sign in again to continue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex justify-end">
          <Button asChild>
            <a ref={signInLink} href={`/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(returnTo)}`}>
              Sign in again
            </a>
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
