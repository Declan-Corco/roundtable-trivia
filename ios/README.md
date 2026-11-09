# roundtable for iOS

A native iPhone and iPad app around the roundtable website. The app opens **https://round-table.site** in a full-screen web view. Game changes you make on the server show up in the app straight away, with no app update needed.

**What the app adds over Safari**

- The roundtable icon on the home screen, and a branded launch screen.
- No browser bars, so the game uses the whole screen.
- The screen stays awake during games.
- Native haptics when you tap an answer, plus a success buzz when you're right.
- A built-in **QR scanner** for joining games, and join links can open the app (see below).
- A "Can't reach the table" screen with **Try again** when there's no connection.
- Links to other websites open in Safari.
- Players stay signed in to their game if they switch apps or relaunch.
- Works on iPad too, which makes a good host screen.

## Opening games from the QR code

The lobby's QR code is a normal web link (`https://round-table.site/join?pin=…`), so people without the app can still join from their browser. There are three ways it opens the app instead:

| How | Works with the free (sideloaded) app? | What the player does |
|---|---|---|
| **Scan inside the app** | Yes | Opens the app and taps **Scan the QR code** on the join screen. |
| **"Open in app" link** | Yes | Scans with the Camera as usual. On the join page in Safari, taps **Open this game in it**, and the app opens straight into that game. |
| **Universal link** | No, it needs a paid Apple Developer account | Scans with the Camera, and iOS offers to open the **roundtable app** directly. |

To turn on universal links:

1. Build a signed app: `TEAM_ID=ABCDE12345 bash scripts/build-ipa.sh`. When it finishes, it prints the exact `APPLE_APP_ID=…` line to use.
2. On your server, add that line to `/etc/roundtable.env` (for example `APPLE_APP_ID=ABCDE12345.site.round-table.app`), then run `sudo systemctl restart roundtable`.
3. Check that https://round-table.site/.well-known/apple-app-site-association now shows your app ID.
4. Install the signed app (TestFlight). iOS checks the link file when the app is installed, so reinstall it if you set this up afterwards.

The domain the app claims comes from the server URL. If you host somewhere else, change `RT_SERVER_URL` and `RT_LINK_DOMAIN` in `project.yml`.

```
ios/
├── project.yml            ← the app's settings (name, bundle ID, version, server URL)
├── Roundtable/            ← Swift source + Assets.xcassets (app icon, launch logo, colours)
├── icon/AppIcon.svg       ← source artwork for the app icon
└── scripts/build-ipa.sh   ← builds the .ipa (unsigned, or signed with your team ID)
```

The Xcode project (`Roundtable.xcodeproj`) is **generated** from `project.yml` by [XcodeGen](https://github.com/yonaskolb/XcodeGen), so it isn't stored in the repo.

---

## Get the IPA without a Mac (GitHub Actions)

Every push that changes `ios/` builds the app on GitHub's Macs.

1. Open the repo on GitHub, then go to **Actions → iOS app**.
2. Open the latest run. To build on demand, select **Run workflow**; you can also point the app at a different server there.
3. When it finishes (about 5 minutes), download **roundtable-ios** from **Artifacts**. It's a zip containing `roundtable-unsigned.ipa`.

This IPA is **unsigned**. iPhones only run signed apps, so you sign it while installing (next section).

## Install it on your iPhone

### Free: Sideloadly or AltStore, with your own Apple ID

1. Install [Sideloadly](https://sideloadly.io) (Windows or Mac) or [AltStore](https://altstore.io).
2. Plug in your iPhone, drag `roundtable-unsigned.ipa` into Sideloadly, enter your Apple ID, and select **Start**.
3. On the iPhone, go to **Settings → General → VPN & Device Management** and trust your Apple ID.
4. On iOS 16 or later, also turn on **Settings → Privacy & Security → Developer Mode** and restart when asked.

With a free Apple ID, the app **expires after 7 days**. Re-install it (AltStore can refresh it automatically). You can have up to 3 sideloaded apps at a time.

### Paid: Apple Developer Program ($99/year), with TestFlight or the App Store

You need a Mac with Xcode for this.

1. Sign in to your developer account in **Xcode → Settings → Accounts**.
2. Find your **Team ID** at developer.apple.com → Account → Membership.
3. Build a signed IPA:
   ```bash
   brew install xcodegen
   cd ios
   TEAM_ID=ABCDE12345 bash scripts/build-ipa.sh
   ```
   This produces `ios/build/roundtable.ipa`, signed for App Store Connect.
4. Upload it with Apple's **Transporter** app (free on the Mac App Store). Then add testers in App Store Connect → TestFlight. Internal testers (up to 100 people on your team) can install it within minutes, with no review.

Other ways to build:

- **Ad hoc** (only devices you've registered): `EXPORT_METHOD=release-testing`.
- **In Xcode itself:** run `xcodegen generate`, open `Roundtable.xcodeproj`, choose your team under **Signing & Capabilities**, then use **Product → Archive** and **Distribute App**.

> **Note on the public App Store:** Apple's review guideline 4.2 ("minimum functionality") sometimes rejects apps that mainly show a website. TestFlight internal testing has no such review, so it's the reliable way to share the app with friends. For a public release, expect to add more native features first.

---

## Common changes

| Change | Where |
|---|---|
| Server the app opens | `RT_SERVER_URL` in `project.yml`, or `RT_SERVER_URL=https://… bash scripts/build-ipa.sh`, or the workflow's input |
| App name under the icon | `CFBundleDisplayName` in `project.yml` |
| Bundle ID (must be unique for the App Store) | `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` |
| Version / build number | `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in `project.yml` (bump the build number for every upload) |
| App icon | Replace `Roundtable/Assets.xcassets/AppIcon.appiconset/AppIcon.png`: 1024×1024 PNG, **no transparency** (iOS rounds the corners itself). The artwork is in `icon/AppIcon.svg`. |
| Launch screen logo / colour | `LaunchLogo.imageset` and `LaunchBackground.colorset` in the asset catalog |

To test against the server on your computer, build with `RT_SERVER_URL=http://192.168.1.48:3000` (your machine's LAN address). Plain `http` is allowed for local network addresses only.
