import { Avatar as AvatarRoot, AvatarFallback } from '@/components/ui/avatar';
import { entityChalk } from '@/lib/ui/entity-chalk';
import { Text, View, type ViewProps } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import { GLYPH_WASH_ALPHA, workspaceGlyphColor, workspaceGlyphWash } from '@/lib/ui/workspace-glyph';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface AvatarProps extends ViewProps {
  /** Size of the avatar container (default: 48) */
  size?: number;

  /** Fallback text (first letter shown) */
  fallbackText?: string;

  /**
   * Colour the tile from `fallbackText` with the shared `chalkColors` (via
   * `entityChalk`): the project and account tile, the same colours web's
   * `EntityAvatar` gives the same name. Draws a 1px border, like web.
   */
  chalk?: boolean;
  /**
   * The workspace's emoji (`KortixWorkspace.icon`): drawn in place of the
   * letter on a neutral tile. Beaten by `glyph`, as on web's `EntityAvatar`.
   */
  emoji?: string | null;
  /**
   * The workspace's glyph (`KortixWorkspace.icon_glyph`): a solid catalogue
   * icon in its colour on a wash of that colour (web: 14% light, 20% dark). A
   * name with no path (a Kortix mark, a catalogue that changed) falls back to
   * the emoji, then the letter.
   */
  glyph?: { name: string; color: string } | null;
}

/**
 * The glyph path data (~950 glyphs, `lib/workspace/glyph-paths.generated.ts`,
 * written by packages/ui/scripts/generate-glyph-paths.tsx). Required on the
 * first glyph tile, so a session with no glyph workspace never evaluates it.
 */
let glyphPaths: Readonly<Record<string, string>> | null = null;
function glyphPath(name: string): string | undefined {
  glyphPaths ??= (require('@/lib/workspace/glyph-paths.generated') as { GLYPH_PATHS: Readonly<Record<string, string>> })
    .GLYPH_PATHS;
  return Object.prototype.hasOwnProperty.call(glyphPaths, name) ? glyphPaths[name] : undefined;
}

/**
 * Avatar — the chalk tile every list and page header shows for a project or
 * account: a rounded square in the name's chalk colour, the first letter of
 * `fallbackText` centered, a 1px border, `style` overriding any of it.
 *
 * Built on the RNR `Avatar` / `AvatarFallback` primitives from
 * `@/components/ui/avatar`.
 */
export function Avatar({ size = 48, fallbackText, chalk = false, emoji, glyph, style, ...props }: AvatarProps) {
  const { colorScheme } = useColorScheme();
  const dark = colorScheme === 'dark';
  const borderRadius = Math.round(size * 0.32); // 32% for slightly softer corners
  const path = glyph ? glyphPath(glyph.name) : undefined;
  if (glyph && path) {
    const solid = workspaceGlyphColor(glyph.color, dark);
    const icon = Math.round(size * 0.55);
    return (
      <View
        accessible={false}
        style={[
          {
            width: size,
            height: size,
            borderRadius,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: workspaceGlyphWash(solid, GLYPH_WASH_ALPHA[dark ? 'dark' : 'light'], withAlpha),
          },
          style,
        ]}
        {...props}>
        <Svg width={icon} height={icon} viewBox="0 0 256 256">
          <Path d={path} fill={solid} />
        </Svg>
      </View>
    );
  }
  if (emoji) {
    return (
      <View
        accessible={false}
        style={[
          {
            width: size,
            height: size,
            borderRadius,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: (dark ? THEME.dark : THEME.light).secondary,
          },
          style,
        ]}
        {...props}>
        {/* The tile sits beside the name it stands for: the emoji is decorative. */}
        <Text style={{ fontSize: Math.round(size * 0.55) }} allowFontScaling={false} importantForAccessibility="no">
          {emoji}
        </Text>
      </View>
    );
  }
  const colors = chalk ? chalkDefaults(fallbackText) : { bg: undefined, icon: undefined, border: undefined };

  return (
    <AvatarRoot
      alt={fallbackText ?? 'avatar'}
      className="items-center justify-center overflow-hidden"
      style={[
        {
          width: size,
          height: size,
          backgroundColor: colors.bg,
          borderRadius: borderRadius,
          borderWidth: 1,
          borderColor: colors.border,
        },
        style,
      ]}
      {...props}
    >
      <AvatarFallback className="bg-transparent">
        {fallbackText ? (
          <Text
            style={{
              color: colors.icon,
              fontSize: size * 0.4,
              fontWeight: '600',
            }}
          >
            {(fallbackText.trim().charAt(0) || '?').toUpperCase()}
          </Text>
        ) : null}
      </AvatarFallback>
    </AvatarRoot>
  );
}

function chalkDefaults(name: string | undefined) {
  const colors = entityChalk(name);
  return { bg: colors.background, icon: colors.foreground, border: colors.border };
}
