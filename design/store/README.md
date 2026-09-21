# Store screenshots

What Google Play's listing shows. Everything here was captured from Android
emulators running the app against `packages/fake-gateway`, so no image contains a
real gateway, a real bot or a person's name — the same rule
[CONTRIBUTING.md](../../CONTRIBUTING.md) sets for `docs/screenshots/`, and it
matters more here because a store listing is the most-read surface the project
has.

There is no iOS set yet. App Store Connect wants its own sizes and this round did
not produce them; `docs/release.md` says so in the TestFlight section.

## What Play accepts, and what these are

Play's phone, 7" tablet and 10" tablet sections each take JPEG or PNG, 320–3840 px
on a side, at most 8 MB, and an aspect ratio no wider than 2:1. That last rule is
the one that catches people: a modern phone AVD is 1080×2400, which is 2.22:1 and
is **rejected**. The phone captures below are 1080×1920 because the emulator's
display was set to 9:16 before the app was launched, not because anything was
cropped afterwards.

| File                          | Size      | Ratio | What it shows                                                                                                                     |
| ----------------------------- | --------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `phone-01-chats.png`          | 1080×1920 | 16:9  | The chats list: both bots with green presence beads, Writer carrying a numbered unread badge, the filter chips and the tab strip. |
| `phone-02-conversation.png`   | 1080×1920 | 16:9  | One conversation: an outgoing DM line to `@writer`, a cron delivery card, and a long report folded behind **Show more**.          |
| `phone-03-approval.png`       | 1080×1920 | 16:9  | The permission sheet a bot's `run_command` raises, with the command quoted and the four answers.                                  |
| `phone-04-crons.png`          | 1080×1920 | 16:9  | The crons list, Active over Paused, each row with its schedule, its delivery target, its profile and its next run.                |
| `phone-05-dark.png`           | 1080×1920 | 16:9  | The same chat in the dark theme, with a tool card, a token-and-duration footer and the chip an answered approval leaves behind.   |
| `tablet10-01-wide.png`        | 2560×1600 | 16:10 | The two-panel layout: sidebar with the chats list and the tab strip, conversation beside it.                                      |
| `tablet10-02-settings.png`    | 2560×1600 | 16:10 | The Settings overlay over that layout — gateway address, provider, version and status, then the account and chat sections.        |
| `tablet10-03-dark.png`        | 2560×1600 | 16:10 | The same two-panel layout in the dark theme.                                                                                      |
| `tablet7-01-wide.png`         | 1920×1200 | 16:10 | The two-panel layout at 960 dp, which is where a 7" tablet lands in landscape.                                                    |
| `tablet7-02-conversation.png` | 1920×1200 | 16:10 | The sidebar collapsed to its icon rail, so the conversation has the whole width.                                                  |

Light theme and the Blue wallpaper throughout, except the two named `dark`.

## Two things in these images that look like defects and are not

- **Researcher's avatar is a plain rose disc with no letter.** The fake gateway
  answers `has_avatar` for every profile but `writer`, and the asset it serves is
  a 1×1 half-opaque red PNG — deliberately flat, so a run against it shows at a
  glance that `profiles.get_asset` was fetched and rendered rather than quietly
  falling back to a generated initial. `Avatar` draws the image **or** the
  initial, never both, so Researcher gets the disc and Writer gets its `W`. It is
  the fixture, not a broken image.
- **The times inside the app are not 9:41.** The status bar is pinned by
  SystemUI's demo mode; the transcript's timestamps come from the fake gateway,
  which builds its fixtures relative to the moment it started.

## Regenerating them

### The emulators

`Medium_Phone` ships with Android Studio. The two tablets do not exist until you
make them, and `avdmanager` on this machine could not see the installed system
image, so they were written by hand: a `~/.android/avd/<name>.ini` pointing at a
`<name>.avd/config.ini` copied from `Medium_Phone`'s with the panel changed.

| AVD                | `hw.lcd.width` × `height` | `hw.lcd.density` | dp in landscape |
| ------------------ | ------------------------- | ---------------- | --------------- |
| `Medium_Phone`     | 1080 × 2400               | 420              | —               |
| `Hermie_Tablet_10` | 2560 × 1600               | 276              | 1484 × 928      |
| `Hermie_Tablet_7`  | 1200 × 1920               | 320              | 960 × 600       |

Both tablet entries set `hw.initialOrientation=landscape`, and the 7" one needs
`settings put system user_rotation 1` as well because its panel is portrait.
`REGULAR_LAYOUT_MIN_WIDTH` is 700, so both tablets get the two-panel shell.

For the phone, set the display to 9:16 before launching and put it back
afterwards — it is a shared AVD:

```sh
adb shell wm size 1080x1920 && adb shell wm density 420
adb shell wm size reset     && adb shell wm density reset
```

### The app

A **Debug** build, because the launch arguments below are what make one launch
equal one screenshot and they are gated off in Release:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=~/Library/Android/sdk
cd apps/hermie && npx expo prebuild --platform android
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Metro and the gateway both run on the host; the emulator reaches it at
`10.0.2.2`:

```sh
npm run start --workspace @hermie/app
npm run fake-gateway -- --auth token --token demo
```

### One launch, one screenshot

`MainActivity` is `launchMode="singleTask"`, so `getIntent()` keeps answering the
intent the activity was created with. **Force-stop between launches** or you will
photograph the previous set's arguments. The `-d` URL is what sends a Debug build
past `expo-dev-client`'s launcher straight to Metro's bundle:

```sh
adb shell am force-stop dev.hermie.app
adb shell am start -a android.intent.action.VIEW \
  -n dev.hermie.app/.MainActivity \
  -d 'exp+hermie://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081' \
  --es hermieGateway http://10.0.2.2:9119 --es hermieToken demo \
  --es hermieTheme light --es hermiePreset blue \
  --es hermieOpen chat:researcher
```

The grammar is the one CONTRIBUTING.md documents for `xcrun simctl`; on Android it
arrives as Intent extras instead of a process argument vector. On the very first
launch after an install, `expo-dev-client` puts its own onboarding sheet over the
app — dismiss it once per device.

**`--hermieGateway` cannot be used for `tablet10-02-settings.png`.** The seed does
not probe, so it stores no gateway version and Settings then shows "Unknown". That
one image was made by running the real four-step wizard by hand — Settings →
Change gateway → Forget it, then the address `http://10.0.2.2:9119`, the token
`demo`, the connection test, Done — and launching afterwards **without**
`--hermieGateway`, since the seed rewrites the stored configuration on every
launch.

### A status bar worth publishing

SystemUI's demo mode pins the clock, the battery and the radios. It does **not**
hide a notification icon, and a fresh AVD posts at least one — a Safety Center
"set a screen lock" shield, or a Play Store update. Snooze whatever is there
first:

```sh
adb shell cmd notification list
adb shell cmd notification snooze --for 86400000 '<key>'

adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 -e fully true
adb shell am broadcast -a com.android.systemui.demo -e command network -e mobile hide
adb shell am broadcast -a com.android.systemui.demo -e command exit   # when you are done
```

A stock AVD also ships with every animation scale at zero, which React Native
reads as Reduce Motion — see the Android section of `docs/platform-notes.md`. Turn
them on before judging anything that moves:

```sh
adb shell settings put global animator_duration_scale 1
adb shell settings put global transition_animation_scale 1
adb shell settings put global window_animation_scale 1
```

### Capturing, and stripping what the device wrote

```sh
adb exec-out screencap -p > shot.png
```

`screencap` writes `sBIT` and `sRGB` alongside the image. Neither is metadata, but
"what the device felt like writing" is not a thing to publish unread, so every
file here was decoded and re-encoded from its pixels with no ancillary chunks at
all — `IHDR`, `IDAT`, `IEND` and nothing else, which is also how the absence of
EXIF and XMP is demonstrated rather than assumed:

```python
from PIL import Image
from PIL.PngImagePlugin import PngInfo

with Image.open(src) as im:
    im.convert("RGB").save(dst, format="PNG", optimize=True, pnginfo=PngInfo())
```

To check a file you did not make:

```sh
python3 - <<'PY'
d = open("phone-01-chats.png","rb").read(); i = 8
while i < len(d):
    n = int.from_bytes(d[i:i+4],"big"); print(d[i+4:i+8].decode()); i += 12+n
PY
```
