import { VOXL_RELEASE_URL, VOXL_SHA256_AMD64, VOXL_SHA256_ARM64 } from '../runtime-versions';

/**
 * The session desktop every image with an Ubuntu 24.04 base carries: Xvfb,
 * XFCE, PulseAudio and voxl (github.com/tembo/voxl, MIT), which streams the
 * display to the browser as H.264 over a WebSocket on port 6901.
 * `apps/sandbox/entrypoint.sh` starts it at boot; `kortix-desktop` (a link to
 * that script) starts, stops and reports it inside the box.
 *
 * voxl is a prebuilt binary (apps/sandbox/voxl/release.sh), so no image build
 * compiles Rust. It links Ubuntu 24.04's libx264.so.164 and libyuv. A custom
 * template on another base (Ubuntu 22.04, Debian 12) has no such packages:
 * there the step installs nothing and the box boots without a desktop, rather
 * than failing the template's whole image build. On a 24.04 base every check
 * is hard, so the platform default can never ship without one.
 *
 * Runs as root. Single line, no heredoc: E2B's Dockerfile parser cannot read
 * heredocs.
 */
export const SANDBOX_DESKTOP_PACKAGES = [
  'adwaita-icon-theme',
  'dbus-x11',
  'fonts-inter-variable',
  'greybird-gtk-theme',
  'libopus0',
  'libpulse0',
  'librsvg2-common',
  'libx264-164',
  'libyuv0',
  'pulseaudio',
  'thunar',
  'x11-xserver-utils',
  'xfce4-panel',
  'xfce4-session',
  'xfce4-settings',
  'xfce4-terminal',
  'xfdesktop4',
  'xfwm4',
  'xvfb',
];

/**
 * The path data of the brand kit's master files, as is (kortix-brand
 * `brandmark.md`: composite the file, never redraw it). `desktop.test.ts`
 * checks both against `apps/web/public/brandkit/Logo/`.
 */
export const KORTIX_LOGO_PATHS: readonly string[] = [
  'M139.522 139.53H162.84C162.84 109.932 147.046 84.0225 123.427 69.7694C147.046 55.5163 162.839 29.6068 162.839 0.00859395H139.522C139.522 28.0165 119.455 51.4472 93.0774 56.9407V0.00859395H69.7625V56.9407C43.2607 51.5428 23.3183 28.1045 23.3183 0.00859395H0.000517529C0.000517529 29.6068 15.7941 55.5163 39.4134 69.7694C15.7938 84.0225 0 109.932 0 139.53H23.3178C23.3178 111.434 43.2606 87.996 69.7625 82.5981V139.556H93.0774V82.598C119.579 87.9957 139.522 111.434 139.522 139.53Z',
  'M379.024 141.074C348.339 141.074 326.422 119.156 326.422 89.2687C326.422 59.3812 348.339 37.4636 379.024 37.4636C409.509 37.4636 431.426 59.3812 431.426 89.2687C431.426 119.156 409.509 141.074 379.024 141.074ZM379.024 119.953C395.561 119.953 406.719 107.4 406.719 89.2687C406.719 71.1369 395.561 58.5842 379.024 58.5842C362.287 58.5842 351.129 71.1369 351.129 89.2687C351.129 107.4 362.287 119.953 379.024 119.953Z',
  'M500.433 59.5804V39.0577H492.199C475.462 39.0577 441.988 49.0999 441.988 89.2687V139.48H466.496L467.243 89.2687C467.243 70.1407 472.673 59.5804 488.214 59.5804H500.433Z',
  'M255.933 0.000104096H231.24V139.452H255.933V82.5926C282.273 88.0977 302.057 111.452 302.057 139.426H325.358C325.358 109.848 309.576 83.9564 285.972 69.713C309.575 55.4697 325.358 29.5779 325.358 0H302.056C302.056 27.8862 282.15 51.2318 255.933 56.832V0.000104096Z',
  'M509.742 8.77166H534.25V39.0577H568.298V59.5804H534.25V103.415C534.25 113.577 539.629 118.758 548.795 118.758H568.298V139.48H546.006C524.088 139.48 509.742 126.728 509.742 104.412V8.77166Z',
  'M578.743 13.1152C578.762 5.86622 584.644 0 591.893 0C599.17 0 605.063 5.90915 605.044 13.1857L605.042 13.7245C605.023 20.9735 599.141 26.8397 591.892 26.8397C584.615 26.8397 578.722 20.9306 578.741 13.654L578.743 13.1152ZM579.774 139.48V39.0577H604.282V139.48H579.774Z',
  'M638.582 139.42H616.248C616.248 118.788 626.473 100.544 642.133 89.479C626.474 78.4143 616.249 60.1716 616.249 39.5397H638.583C638.583 55.3892 648.093 69.0176 661.718 75.0301C675.342 69.0176 684.852 55.3892 684.852 39.5397H707.187C707.187 60.1716 696.961 78.4143 681.302 89.479C696.962 100.544 707.188 118.788 707.188 139.42H684.853C684.853 123.571 675.343 109.943 661.718 103.93C648.092 109.943 638.582 123.571 638.582 139.42Z',
];
export const DOSCO_SYMBOL_PATH =
  'M674.61 91.7C683.67 89.72 690.76 94.59 697.75 99.58C708.2 107.05 718.47 114.83 728.61 122.73C775.5 159.26 822.85 195.32 865.51 236.84C878.15 249.15 890.45 262.15 901.43 275.98C905.56 281.17 911.61 287.3 907.05 294.3C903.03 300.47 885.74 302.43 878.67 304.19C853.56 310.43 828.39 317.74 804.57 327.97C778.97 338.96 753.31 350.92 729.38 365.27C713.66 374.7 694.92 389.25 676.11 389.72C656.15 390.22 640.06 377.15 623.4 367.91C593.46 351.31 562.38 336.32 530.39 324.11C509.54 316.15 488.1 309.7 466.54 304.05C459.61 302.24 444.67 300.97 440.09 295.45C434.38 288.6 441.19 281.37 445.49 276.18C457.16 262.14 469.68 248.74 483.19 236.46C525.1 198.37 570.83 165.36 616.43 131.89C629.18 122.53 641.62 112.73 654.5 103.53C660.78 99.04 666.87 93.4 674.61 91.7Z M892.87 287.41C892.98 283.69 890.25 281.33 887.85 278.62C883.07 273.23 878.55 267.63 873.61 262.37C852.97 240.39 830.76 220.22 807.62 200.89C778.29 176.39 747.95 153.02 717.56 129.84C709.42 123.64 701.31 117.4 693.09 111.3C689.31 108.49 684.88 104.55 680.02 104.02C673.31 103.29 667.71 109.68 662.8 113.4C651.09 122.26 639.3 131.11 627.4 139.73C581.6 172.91 535.77 205.99 493.5 243.61C482.49 253.41 472.04 263.96 462.53 275.2C459.66 278.59 454.16 282.83 454 287.39C456.94 290.2 461.81 290.3 465.63 291.13C474.34 293.03 482.95 295.51 491.51 298.01C515.79 305.11 539.81 313.96 562.87 324.4C569.84 327.56 576.73 330.88 583.67 334.09C586.9 335.58 590.29 338.03 593.71 338.95C595.47 339.43 597.67 339.06 599.46 338.85C613.58 337.27 627.96 332.11 640.62 325.79C650.63 320.79 661.56 314.38 673.01 313.96C683.94 313.55 692.67 319.01 702.12 323.57C715.36 329.96 735.63 339.64 750.4 339.51C754.72 339.48 759.17 335.81 762.95 333.99C772.66 329.31 782.34 324.57 792.21 320.26C814.43 310.56 837.31 302.94 860.57 296.21C867.07 294.33 873.65 292.51 880.26 291.07C884.35 290.18 889.4 289.9 892.87 287.41Z M683.11 237.36C686.99 237.02 690.59 233.31 693.53 230.96C701.79 224.37 715.25 211.12 715.28 199.81C715.29 194.95 711.64 193.45 709.74 189.64C713.26 188.55 716.42 189.08 720.05 189.74C730.13 191.55 752.77 198.13 747.79 212.36C743.23 225.37 721.04 236.64 708.76 240.63C704.05 242.16 691.24 243.82 689.01 247.53C691.03 253.81 697.49 259.55 702.02 264.22C716.49 279.17 735.23 290.34 754.65 297.59C760.29 299.7 777.55 303.5 780.82 306.18C774.93 310.15 766.91 312.02 760.14 314.01C749.62 317.1 736.23 320.68 725.23 318.58C717.35 317.07 711.18 311.44 705.59 306.05C695.41 296.23 687.12 284.6 679.35 272.84C676.57 268.64 674.4 264.01 671.41 259.95C669.26 262.03 668.03 265.42 666.45 268.01C663.15 273.44 659.34 278.46 655.01 283.12C637.65 301.75 613.15 314.65 587.77 317.04C581.65 317.61 569.68 319.34 564.27 316.82C566.68 313.98 577.29 310.6 581.33 308.75C592.55 303.59 603.39 297.32 613.19 289.78C641.87 267.75 655.37 240.14 659.32 204.51C660.53 193.55 661.67 182.02 659.75 171.08C658.98 166.7 657.58 162.32 655.2 158.54C653.6 156.01 650.81 154.11 650.05 151.33C655.72 150.28 661.84 151.51 667.42 152.75C675.49 154.54 689.15 158.74 692.52 167.36C694.71 172.96 692.05 180.66 691.04 186.36C688.92 198.37 686.69 210.42 684.92 222.49C684.2 227.38 682.19 232.5 683.11 237.36Z M642.48 194.93C645.12 199.06 643.16 207.74 642.2 212.36C639.36 226.03 628.56 254.35 611.19 254.3C600.87 254.26 593.03 243.16 593.32 233.45C593.6 224.43 600.91 214.04 609.63 211.29C609.57 214.44 607.16 217.1 608.12 220.47C609.89 226.67 617.61 223.55 621.26 221.25C631.26 214.91 637.12 205.1 642.48 194.93Z';
export const KORTIX_SYMBOL_PATH = DOSCO_SYMBOL_PATH;

// The Dosco crest wallpaper:
// the black symbol at 12% of the canvas width, dead centre on #FFFFFF.
// Drawn on the 2560x1600 desktop and zoomed by xfdesktop, so any size the
// viewer resizes the desktop to keeps it centred.
const WALLPAPER_W = 2560;
const WALLPAPER_H = 1600;
const SYMBOL_SCALE = (0.12 * WALLPAPER_W) / 477.23;
const SYMBOL_TX = (WALLPAPER_W - 477.23 * SYMBOL_SCALE) / 2 - 434.38 * SYMBOL_SCALE;
const SYMBOL_TY = (WALLPAPER_H - 300.5 * SYMBOL_SCALE) / 2 - 89.72 * SYMBOL_SCALE;
const WALLPAPER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${WALLPAPER_W}" height="${WALLPAPER_H}" viewBox="0 0 ${WALLPAPER_W} ${WALLPAPER_H}"><rect width="100%" height="100%" fill="#FFFFFF"/><path fill="#0A0A0A" fill-rule="evenodd" transform="translate(${SYMBOL_TX} ${SYMBOL_TY}) scale(${SYMBOL_SCALE})" d="${DOSCO_SYMBOL_PATH}"/></svg>`;
// Stock Greybird, plus the dock: solid white with a hairline border, and
// quiet grey hover and pressed states instead of Greybird's blue. Square
// corners: with no compositor (see xfwm4 below) a rounded corner paints black.
const THEME_CSS = `@import url("/usr/share/themes/Greybird/gtk-3.0/gtk.css");
.xfce4-panel.background { background-color: #FFFFFF; color: #0A0A0A; border: 1px solid #E5E5E5; border-bottom: none; }
.xfce4-panel.background button { border-radius: 10px; color: #0A0A0A; text-shadow: none; }
.xfce4-panel.background button:hover, .xfce4-panel.background button:active:hover, .xfce4-panel.background button:checked:hover { background-image: none; background-color: #F0F0F0; border-color: transparent; box-shadow: none; }
.xfce4-panel.background button:active, .xfce4-panel.background button:checked { background-image: none; background-color: #E5E5E5; border-color: transparent; box-shadow: none; }
`;

// voxl's MIT license, shipped with the binary as the license requires.
const VOXL_LICENSE = `MIT License

Copyright (c) 2026 Tembo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const DIR = '/usr/share/kortix/desktop';
const BROWSER = '/usr/local/bin/kortix-desktop browser';
const XFCONF = '/etc/xdg/xfce4/xfconf/xfce-perchannel-xml';

/** xfconf properties as XML. Nested objects are groups, arrays are arrays. */
function props(o: Record<string, unknown>): string {
  const type = (v: unknown) =>
    typeof v === 'boolean' ? 'bool' : typeof v === 'string' ? 'string' : Number.isInteger(v) ? 'int' : 'double';
  return Object.entries(o)
    .map(([k, v]) =>
      Array.isArray(v)
        ? `<property name="${k}" type="array">${v.map((x) => `<value type="${type(x)}" value="${x}"/>`).join('')}</property>`
        : v && typeof v === 'object'
          ? `<property name="${k}" type="empty">${props(v as Record<string, unknown>)}</property>`
          : `<property name="${k}" type="${type(v)}" value="${v}"/>`,
    )
    .join('');
}

function channel(name: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<channel name="${name}" version="1.0">${body}</channel>\n`;
}

/**
 * The look, close to stock XFCE: Greybird, the Kortix symbol wallpaper,
 * no desktop icons, and a centred dock with three launchers (browser,
 * terminal, files). System defaults under /etc/xdg, so a user's own changes
 * in ~/.config win.
 */
export const SANDBOX_DESKTOP_FILES: Record<string, string> = {
  ['/usr/share/doc/voxl/LICENSE']: VOXL_LICENSE,
  [`${DIR}/wallpaper.svg`]: WALLPAPER_SVG,
  ['/usr/share/themes/Kortix/gtk-3.0/gtk.css']: THEME_CSS,
  [`${XFCONF}/xsettings.xml`]: channel('xsettings', props({
    Net: { ThemeName: 'Kortix', IconThemeName: 'Adwaita' },
    // voxl draws the desktop at 1.5 desktop pixels per CSS pixel (its default
    // --resize-scale), so 144 DPI shows text at its normal size, sharp.
    Xft: { DPI: 144 },
    Gtk: { FontName: 'Inter Variable 10' },
  })),
  [`${XFCONF}/xfwm4.xml`]: channel('xfwm4', props({
    general: {
      theme: 'Greybird',
      workspace_count: 1,
      // Off on purpose. voxl re-encodes only the regions X reports as damaged,
      // and under xfwm4's compositor those reports miss repaints: the stream
      // smears and keeps stale regions until a keyframe.
      use_compositing: false,
    },
  })),
  [`${XFCONF}/xfce4-desktop.xml`]: channel('xfce4-desktop', props({
    'desktop-icons': { style: 0 },
    backdrop: {
      screen0: {
        monitorscreen: {
          workspace0: { 'color-style': 0, rgba1: [1, 1, 1, 1], 'image-style': 5, 'last-image': `${DIR}/wallpaper.svg` },
        },
      },
    },
  })),
  ['/etc/xdg/xfce4/panel/default.xml']: panelXml(),
  // The dock's launchers open the browser, xfce4-terminal and Thunar without
  // asking which one to use. The browser is the agent's own (`kortix-desktop
  // browser` in apps/sandbox/entrypoint.sh): the desktop has no second one.
  ['/usr/share/xfce4/helpers/kortix-browser.desktop']: `[Desktop Entry]\nType=X-XFCE-Helper\nX-XFCE-Category=WebBrowser\nName=Browser\nIcon=web-browser\nX-XFCE-Commands=${BROWSER}\nX-XFCE-CommandsWithParameter=${BROWSER} "%s"\n`,
  ['/etc/xdg/xfce4/terminal/terminalrc']:
    '[Configuration]\nMiscMenubarDefault=FALSE\nMiscToolbarDefault=FALSE\nScrollingBar=TERMINAL_SCROLLBAR_NONE\nFontName=DejaVu Sans Mono 10\nColorForeground=#0A0A0A\nColorBackground=#FFFFFF\nColorCursor=#0A0A0A\nColorBold=#0A0A0A\nColorPalette=#0A0A0A;#C01C28;#26A269;#A2734C;#12488B;#A347BA;#2A7BDE;#D0CFCC;#5E5C64;#F66151;#33D17A;#C88800;#2A7BDE;#C061CB;#33C7DE;#FFFFFF\nMiscDefaultGeometry=100x30\n',
  ['/etc/xdg/xfce4/helpers.rc']: 'WebBrowser=kortix-browser\nTerminalEmulator=xfce4-terminal\nFileManager=thunar\n',
};

function panelXml(): string {
  const launchers = ['xfce4-web-browser.desktop', 'xfce4-terminal-emulator.desktop', 'xfce4-file-manager.desktop'];
  const ids = launchers.map((_, i) => i + 1);
  // p=10 is bottom centre; length 1 shrinks the panel to its icons: a dock.
  const panel = props({
    'dark-mode': false,
    'panel-1': { position: 'p=10;x=0;y=0', length: 1, 'position-locked': true, size: 64, 'icon-size': 40, 'plugin-ids': ids },
  });
  const plugins = launchers
    .map((item, i) => `<property name="plugin-${i + 1}" type="string" value="launcher">${props({ items: [item] })}</property>`)
    .join('');
  return channel(
    'xfce4-panel',
    `<property name="configver" type="int" value="2"/><property name="panels" type="array"><value type="int" value="1"/>${panel}</property><property name="plugins" type="empty">${plugins}</property>`,
  );
}

/** Each file as `printf <base64> | base64 -d`: no heredoc, no quoting. */
const writeFiles = Object.entries(SANDBOX_DESKTOP_FILES)
  .map(([path, body]) => `mkdir -p ${path.slice(0, path.lastIndexOf('/'))} && printf %s ${btoa(body)} | base64 -d > ${path}`)
  .join(' && ');

export const SANDBOX_DESKTOP_INSTALL_COMMAND =
  'apt-get update' +
  ' && if apt-cache show libx264-164 libyuv0 >/dev/null 2>&1; then' +
  ` apt-get install -y --no-install-recommends ${SANDBOX_DESKTOP_PACKAGES.join(' ')}` +
  ' && case "$(uname -m)" in' +
  ` x86_64) voxl_arch=amd64; voxl_sha=${VOXL_SHA256_AMD64} ;;` +
  ` aarch64|arm64) voxl_arch=arm64; voxl_sha=${VOXL_SHA256_ARM64} ;;` +
  ' *) echo "unsupported voxl architecture: $(uname -m)" >&2; exit 1 ;; esac' +
  ` && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/voxl.gz "${VOXL_RELEASE_URL}/voxl-linux-\${voxl_arch}.gz"` +
  ' && echo "${voxl_sha}  /tmp/voxl.gz" | sha256sum -c -' +
  ' && gunzip -c /tmp/voxl.gz > /usr/local/bin/voxl && rm /tmp/voxl.gz && chmod 0755 /usr/local/bin/voxl' +
  " && ! ldd /usr/local/bin/voxl | grep -q 'not found'" +
  ' && ln -sf /usr/local/bin/kortix-entrypoint /usr/local/bin/kortix-desktop' +
  ` && ${writeFiles};` +
  ' else echo "desktop: skipped, this base lacks the Ubuntu 24.04 libraries voxl links"; fi' +
  ' && rm -rf /var/lib/apt/lists/*';
