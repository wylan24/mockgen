# React Native (Expo) example

A task list with pull-to-refresh and infinite scroll, built against [`api/openapi.yaml`](api/openapi.yaml) with mockgen standing in for the backend.

## Run it

```bash
npm install
npm run mock    # terminal 1: mock server on port 4010, reachable from your network
npm start       # terminal 2: Expo; press i for iOS, a for Android, or scan the QR code
```

## Reaching the mock server from a device

A phone or emulator is a different machine from your computer, so `localhost` on it isn't your computer. [`App.tsx`](App.tsx) picks the address like this:

| Where the app runs | API address |
| --- | --- |
| iOS simulator | `http://127.0.0.1:4010` (the simulator shares your Mac's network) |
| Android emulator | `http://10.0.2.2:4010` (the emulator's alias for your computer) |
| A physical phone | Your computer's LAN address, set with `EXPO_PUBLIC_API_URL` |

On a physical phone (same Wi-Fi as your computer):

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.20:4010 npm start
```

That's why `npm run mock` uses `--host 0.0.0.0`: by default mockgen listens only on `127.0.0.1`, which other devices can't reach. Only do this on a network you trust, because anyone on it can reach the mock server.

## Try

- **Infinite scroll.** Scroll down: pages of 10 load from a stable 50-record collection, and the list stops at 50.
- **Pull to refresh.** You get the same data every time, because mockgen output is deterministic.
- **Error state.** Tap "Simulate a 500 error": requests send `X-Mock-Status: 500` and the app shows its error message.

## Notes

- Expo Go allows plain `http://` requests. A custom development build on Android blocks them unless cleartext traffic is enabled for development.
- This example is type-checked and bundled for Android in CI. It isn't run on a device there.
