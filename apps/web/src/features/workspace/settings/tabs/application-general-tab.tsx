'use client';

import React, { useEffect, useState } from 'react';
import { Switch } from '@kortix/ui/switch';
import { Button } from '@kortix/ui/button';
import { BellIcon, LaptopIcon, MoonIcon, ShieldCheckIcon } from '@phosphor-icons/react';

const STORAGE_PREVENT_SLEEP = 'dosco-pref-prevent-sleep';
const STORAGE_KEEP_BACKGROUND = 'dosco-pref-keep-background';
const STORAGE_REMOTE_CONTROL = 'dosco-pref-remote-control';

export function ApplicationGeneralTab() {
  const [preventSleep, setPreventSleep] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem(STORAGE_PREVENT_SLEEP) !== 'false';
  });

  const [keepInBackground, setKeepInBackground] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEEP_BACKGROUND) === 'true';
  });

  const [enableRemoteControl, setEnableRemoteControl] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(STORAGE_REMOTE_CONTROL) === 'true';
  });

  const [notificationPermission, setNotificationPermission] = useState<string>('default');

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  const handlePreventSleepChange = (checked: boolean) => {
    setPreventSleep(checked);
    localStorage.setItem(STORAGE_PREVENT_SLEEP, String(checked));
    if (checked && 'wakeLock' in navigator) {
      try {
        navigator.wakeLock.request('screen').catch(() => {});
      } catch {}
    }
  };

  const handleKeepBackgroundChange = (checked: boolean) => {
    setKeepInBackground(checked);
    localStorage.setItem(STORAGE_KEEP_BACKGROUND, String(checked));
  };

  const handleRemoteControlChange = (checked: boolean) => {
    setEnableRemoteControl(checked);
    localStorage.setItem(STORAGE_REMOTE_CONTROL, String(checked));
  };

  const handleRequestNotification = async () => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      try {
        const res = await Notification.requestPermission();
        setNotificationPermission(res);
      } catch {
        // Fallback for environments where Notification is blocked
      }
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 pb-10">
      {/* General Section */}
      <section className="space-y-4">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          General
        </h3>
        <div className="space-y-4 rounded-xl border border-border/60 bg-card/40 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="pref-prevent-sleep" className="text-sm font-medium text-foreground cursor-pointer">
                Prevent Sleep
              </label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Prevent the computer from sleeping while agent sessions or background tasks are running.
              </p>
            </div>
            <Switch
              id="pref-prevent-sleep"
              checked={preventSleep}
              onCheckedChange={handlePreventSleepChange}
              aria-label="Prevent Sleep"
            />
          </div>

          <div className="border-t border-border/40 pt-4 flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="pref-keep-bg" className="text-sm font-medium text-foreground cursor-pointer">
                Keep In Menu Bar / Background
              </label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Keep the application accessible from the system menu bar and running in the background when all windows are closed.
              </p>
            </div>
            <Switch
              id="pref-keep-bg"
              checked={keepInBackground}
              onCheckedChange={handleKeepBackgroundChange}
              aria-label="Keep in background"
            />
          </div>
        </div>
      </section>

      {/* Remote Control Section */}
      <section className="space-y-4">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Remote Control
        </h3>
        <div className="rounded-xl border border-border/60 bg-card/40 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="pref-remote-control" className="text-sm font-medium text-foreground cursor-pointer">
                Enable Remote Control
              </label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Work with local agents, computer control, and workspace tunnels from another paired device.
              </p>
            </div>
            <Switch
              id="pref-remote-control"
              checked={enableRemoteControl}
              onCheckedChange={handleRemoteControlChange}
              aria-label="Enable Remote Control"
            />
          </div>
        </div>
      </section>

      {/* Notifications Section */}
      <section className="space-y-4">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Notifications
        </h3>
        <div className="rounded-xl border border-border/60 bg-card/40 p-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <span className="text-sm font-medium text-foreground">
              Notification Settings
            </span>
            <p className="text-xs text-muted-foreground leading-relaxed">
              To modify notification alert preferences, check your browser or operating system preferences.
              {notificationPermission === 'granted' ? ' (Currently Granted)' : ''}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRequestNotification}
            className="shrink-0 text-xs cursor-pointer"
          >
            {notificationPermission === 'granted' ? 'Permissions Active' : 'Request Permissions'}
          </Button>
        </div>
      </section>

      {/* Version Section */}
      <section className="space-y-4">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Version & Architecture
        </h3>
        <div className="rounded-xl border border-border/60 bg-card/40 p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">App version</span>
            <span className="font-mono text-foreground font-medium">2.29.0</span>
          </div>
          <div className="border-t border-border/40 pt-3 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Sandbox Provider</span>
            <span className="font-medium text-foreground">E2B Sovereign Cloud MicroVM</span>
          </div>
          <div className="border-t border-border/40 pt-3 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Inference Gateway</span>
            <span className="font-medium text-foreground">OpenRouter & BYOK Catalog</span>
          </div>
        </div>
      </section>
    </div>
  );
}
