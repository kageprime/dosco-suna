'use client';

import { useTranslations } from '@/i18n/use-translations';
import { Button } from '@kortix/ui/button';
import { infoToast } from '@kortix/ui/toast';
import { X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import {
  INSTALL_DISMISSED_KEY,
  IOS_HINT_DISMISSED_KEY,
  COARSE_POINTER_QUERY,
  STANDALONE_QUERY,
  dismiss,
  dismissed,
  isIosWithoutInstallPrompt,
  isStandalone,
  offersInstallCard,
} from './pwa-state';

/** Chromium's install event. iOS never fires it; the one-time hint covers that path. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/** The host is a `ssr: false` dynamic chunk, so these read the browser only. */
const displayStandalone = () => {
  // `standalone` is iOS-only and absent from lib.dom: the `in` guard reads it
  // without a cast (TS narrows the unlisted property to `unknown`).
  const iosStandalone = 'standalone' in navigator && navigator.standalone === true;
  return isStandalone(window.matchMedia(STANDALONE_QUERY).matches, iosStandalone);
};

/**
 * The PWA host (KRTX-4719): registers the app-shell service worker on load,
 * offers the install entry point on touch devices where the browser can install, shows the
 * one-time iOS Share → Add to Home Screen hint, and offers the waiting
 * service worker's update — the swap lands only on the reload it triggers.
 * Suppressed while standalone (the app is already installed). Mounted once by
 * the root layout's `RootClientHosts`, skipped in the desktop shell.
 */
export function PwaClient() {
  const t = useTranslations('hardcodedUi');
  // The registration effect runs once and reads copy through this ref, so a
  // mid-session locale change never re-registers the worker.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(() =>
    dismissed(window.localStorage, INSTALL_DISMISSED_KEY),
  );
  const [showIosHint, setShowIosHint] = useState(() => {
    const standalone = displayStandalone();
    return (
      !standalone &&
      isIosWithoutInstallPrompt(navigator.userAgent, navigator.maxTouchPoints || 0, standalone) &&
      !dismissed(window.localStorage, IOS_HINT_DISMISSED_KEY)
    );
  });
  const updateRef = useRef<{ registration: ServiceWorkerRegistration; reload: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const offerUpdate = (registration: ServiceWorkerRegistration) => {
      // One toast per load; the next load re-offers while a worker waits.
      if (updateRef.current) return;
      updateRef.current = { registration, reload: false };
      infoToast(
        tRef.current.raw(
          'autoComponentsPwaPwaClientJsxTextKortixWasUpdatedRefreshToGetTheNewVeae4f0718',
        ),
        {
          duration: 12000, // audit:allow toast display time, not a motion duration
          actions: [
            {
              label: tRef.current.raw('i18nComplete.text0e9161011702'),
              onClick: () => {
                const update = updateRef.current;
                if (!update || update.reload) return;
                update.reload = true;
                update.registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
                // The swap activates `controllerchange` below; nothing reloads
                // unless a waiting worker actually takes over.
              },
            },
          ],
        },
      );
    };

    const watch = (registration: ServiceWorkerRegistration) => {
      // An update may already wait when this tab loads.
      if (registration.waiting && navigator.serviceWorker.controller) {
        offerUpdate(registration);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => {
          // `controller` set: this tab runs an older worker, so `installed`
          // is a waiting update, not this tab's first install.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            offerUpdate(registration);
          }
        });
      });
    };

    const onControllerChange = () => {
      // Only a user-triggered swap reloads. The first worker's `claim` fires
      // the same event on a tab that never had a controller.
      if (updateRef.current?.reload) window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    const register = () => {
      navigator.serviceWorker.register('/sw.js').then(watch).catch(() => undefined);
      // A signed-out surface is the one place the previous identity's cached
      // route HTML must not survive: the shell cache holds the server-rendered
      // session title of every route that user visited, and the sign-out reset
      // cannot reach the Cache API. `/offline.html` is kept by the worker.
      if (/(?:^|\/)(?:[a-z]{2}\/)?auth\/?$/.test(window.location.pathname)) {
        navigator.serviceWorker.ready
          .then((registration) => registration.active?.postMessage({ type: 'PURGE_SHELL' }))
          .catch(() => undefined);
      }
    };
    // A dynamic chunk mounts after hydration, when `load` has usually fired.
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }

    return () => {
      window.removeEventListener('load', register);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  useEffect(() => {
    // Chrome fires `beforeinstallprompt` on every qualifying load; holding the
    // event here IS the install entry point. Without `preventDefault` Chrome
    // shows its own mini-infobar instead.
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const dismissInstallCard = () => {
    dismiss(window.localStorage, INSTALL_DISMISSED_KEY);
    setInstallDismissed(true);
  };

  const dismissIosHint = () => {
    dismiss(window.localStorage, IOS_HINT_DISMISSED_KEY);
    setShowIosHint(false);
  };

  const install = async () => {
    const event = installEvent;
    if (!event) return;
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') dismiss(window.localStorage, INSTALL_DISMISSED_KEY);
    setInstallEvent(null);
  };

  // Desktop keeps the browser's own Install entry in the address bar; the card
  // would cover app controls at the bottom-right.
  if (installEvent && !installDismissed && offersInstallCard(window.matchMedia(COARSE_POINTER_QUERY).matches)) {
    return (
      <PwaCard
        t={t}
        body={t.raw('autoComponentsPwaPwaClientJsxTextAddKortixToYourHomeScreen83b6a02f')}
        onDismiss={dismissInstallCard}
      >
        <Button size="sm" onClick={install} className="mt-3">
          {t.raw('i18nComplete.text569ca49f4aaf')}
        </Button>
      </PwaCard>
    );
  }

  if (showIosHint) {
    return (
      <PwaCard
        t={t}
        body={t.raw(
          'autoComponentsPwaPwaClientJsxTextOnIphoneAndIpadTapShareThenAddToHomb51e7c3a',
        )}
        onDismiss={dismissIosHint}
      />
    );
  }

  return null;
}

/** The shared install/hint card: the maintenance-banner panel idiom, fixed
    bottom-end with the device's safe-area offsets. */
function PwaCard({
  t,
  body,
  onDismiss,
  children,
}: {
  t: ReturnType<typeof useTranslations>;
  body: string;
  onDismiss: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-[110] w-[360px] max-w-[calc(100vw-2rem)]">
      {/* audit:allow device safe-area inset, not a spacing step */}
      <div className="bg-background relative flex items-start gap-3 rounded-md border p-4 shadow-lg">
        <div className="min-w-0 flex-1 pr-6">
          <h3 className="text-foreground text-sm font-semibold text-balance">
            {t.raw('i18nComplete.text569ca49f4aaf')}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed text-pretty">{body}</p>
          {children}
        </div>
        <button
          type="button"
          aria-label={t.raw('i18nComplete.text48845bff334a')}
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 absolute top-2.5 right-2.5 flex size-7 items-center justify-center rounded-md transition-colors active:scale-[0.96]"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
