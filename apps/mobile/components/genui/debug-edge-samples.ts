/**
 * Phone edge cases for the generative UI debug screen (`components/debug/GenuiDebugScreen.tsx`), after the shared
 * samples: long titles beside long badges, broken images, long subtitles, long values at a large text size, and a
 * map to open full screen. Mobile only: each one pins a layout fixed for a 375pt phone. All values are placeholders.
 */
import type { GenuiSample } from '@kortix/shared/genui-samples';

const PHOTO = 'https://kortix.com/banner.png';
/** An https URL that never loads: the neutral well and the image icon, in a box of the same size. */
const BROKEN = 'https://kortix.com/does-not-exist.png';

export const MOBILE_EDGE_SAMPLES: readonly GenuiSample[] = [
  {
    component: 'Card',
    title: 'Card list: long title, long badge, photo (phone)',
    note: 'The badge takes its own line above the title; the title uses the full width. Neither runs past the card.',
    source: `root = Stack([a, b, c], null, "list")
a = Card("Jawhar outskirts", "Quiet farm stays twenty minutes from the old town.", "Rural, west", "${PHOTO}", null, [near])
b = Card("Khuri village and the Barna side", "Dunes at sunset, camel camps, and a long drive back.", "Desert, south", "${PHOTO}", null, [desert, budget])
c = Card("Old town", "Short walks between the sights.", "Centre", "${PHOTO}", null, [short])
near = Badge("Nearby first choice", "good")
desert = Badge("Desert first choice", "good")
budget = Badge("Budget pick for a group", "warn")
short = Badge("New")`,
  },
  {
    component: 'Card',
    title: 'Card list: no images, short and long badges',
    note: 'A short badge stays top right beside the title; a long one goes above it.',
    source: `root = Stack([a, b], null, "list")
a = Card("Option A", "Two minutes from the venue.", null, null, null, [top])
b = Card("A much longer option title that wraps", "Further out, cheaper.", null, null, null, [long])
top = Badge("Top", "good")
long = Badge("Best value for a group", "good")`,
  },
  {
    component: 'Card',
    title: 'Card list: broken thumbnails',
    note: 'Each thumbnail keeps its 96pt box on the neutral well, with the image icon.',
    source: `root = Stack([a, b], null, "list")
a = Card("Broken photo", "The URL does not load.", null, "${BROKEN}")
b = Card("Working photo", "For comparison.", null, "${PHOTO}")`,
  },
  {
    component: 'Card',
    title: 'Single card: long subtitle, many badges, broken photo',
    note: 'The photo well keeps 160pt; the pills wrap inside it; the long subtitle takes its own line.',
    source: `root = Stack([card])
card = Card("The Taj Mahal Palace", "Heritage hotel on the harbour.", "Colaba, South Mumbai, Maharashtra", "${BROKEN}", null, [lux, her, sea, late], 4.7, 33899, "From 24,000 INR")
lux = Badge("Luxury", "good")
her = Badge("Heritage")
sea = Badge("Sea views from the rooms")
late = Badge("Late checkout on request", "warn")`,
  },
  {
    component: 'Compare',
    title: 'Compare: long spec labels and values',
    source: `root = Stack([cmp])
cmp = Compare([a, b], ["Monthly price per seat, billed yearly", "Single sign-on and SCIM provisioning", "Support"], "Team")
a = CompareItem("Starter", ["$0", "Not included on this plan", "Community forum only"])
b = CompareItem("Team", ["$20", "Included", "Email, next business day"])`,
  },
  {
    component: 'StatRow',
    title: 'Stats: long values and units',
    note: 'At a large text size the value and its unit wrap inside the cell.',
    source: `root = Stack([stats])
stats = StatRow([a, b, c])
a = Stat("Annual recurring revenue", "12,480,000", "+12.4% vs last year", "up", "USD")
b = Stat("Median response time", "1,420", "-6%", "down", "milliseconds")
c = Stat("Seats", "418")`,
  },
  {
    component: 'Image',
    title: 'Image with text (figure)',
    note: 'A fixed 4:3 box, the photo cropped to fill it; the broken one keeps the box.',
    source: `root = Stack([ok, broken])
ok = Image("${PHOTO}", "The Kortix banner", null, "Look at the left edge: the mark sits on the grid line, and the wordmark starts one column later.")
broken = Image("${BROKEN}", "A missing image", null, "This image does not load; the box stays the same size.")`,
  },
  {
    component: 'Map',
    title: 'Map: open full screen',
    note: 'Tap the map. Back and Close sit on glass at the top; the place cards swipe at the bottom. Tap a pin, then Back: it returns to every place. Back again closes.',
    source: `root = Stack([map])
map = Map([a, b, c], "Public landmark coordinates", 14)
a = Marker(52.5163, 13.3777, "Brandenburg Gate", "Pariser Platz, 10117 Berlin", "★ 4.7", "https://example.com/brandenburg-gate", "${PHOTO}", "+49 30 1234567", "Landmark")
b = Marker(52.5186, 13.3762, "Reichstag building and the glass dome over the plenary hall", "A long name that truncates on the card", "★ 4.6")
c = Marker(52.5169, 13.4019, "Museum Island", "End of the walk", "★ 4.8")`,
  },
];
