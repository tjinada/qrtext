# Animated QR Transfer - Unraid Docker Deploy

## Option A: Build locally on Unraid

Copy this folder to your Unraid server, for example:

```bash
/mnt/user/appdata/animated-qr-transfer
```

Then SSH into Unraid:

```bash
cd /mnt/user/appdata/animated-qr-transfer
docker build -t animated-qr-transfer:latest .
docker run -d \
  --name animated-qr-transfer \
  -p 8099:80 \
  --restart unless-stopped \
  animated-qr-transfer:latest
```

Open:

```text
http://UNRAID-IP:8099
```

## Option B: Docker Compose

```bash
cd /mnt/user/appdata/animated-qr-transfer
docker compose up -d --build
```

## Tailscale HTTPS

Camera scanning from a phone usually requires HTTPS. Use Tailscale Serve against the Unraid service:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8099
```

Then open the Tailscale HTTPS URL on your phone.

If Tailscale is running inside a container/add-on instead of directly on Unraid, point Serve to the Unraid LAN IP instead:

```bash
tailscale serve --bg --https=443 http://UNRAID-IP:8099
```


## Local libraries
This build does not use CDN scripts. QR generation and gzip are loaded from `libs/` inside the container. Camera scanning uses the browser native `BarcodeDetector` API, so open it over HTTPS/Tailscale for phone camera access.


## iPhone scanner note
This build includes `libs/html5-qrcode.min.js` locally, so iPhone Safari/Chrome should use the bundled scanner over HTTPS. If you still see a scanner-library error, clear browser cache and rebuild/redeploy the Docker image.


## Offline/client note

The browser libraries are stored under `libs/` and served by the container. Client machines do not need internet access as long as they can reach this app over LAN or your HTTPS tunnel. A `400 chars` chunk size option is included for difficult screens/cameras.
