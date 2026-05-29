FROM nginx:alpine

RUN apk add --no-cache curl

WORKDIR /usr/share/nginx/html

COPY . .
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Ensure all browser libraries exist locally in the image.
# The repo ships bundled copies. During build, Unraid may refresh them from CDN.
# If CDN fails, the existing bundled files remain. The build fails only if a file is still missing.
RUN set -eux; \
    mkdir -p /usr/share/nginx/html/libs; \
    curl -fsSL https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js -o /tmp/qrcode.min.js && cp /tmp/qrcode.min.js /usr/share/nginx/html/libs/qrcode-local.js || true; \
    curl -fsSL https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js -o /tmp/pako.min.js && cp /tmp/pako.min.js /usr/share/nginx/html/libs/pako.min.js || true; \
    curl -fsSL https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js -o /tmp/html5-qrcode.min.js && cp /tmp/html5-qrcode.min.js /usr/share/nginx/html/libs/html5-qrcode.min.js || true; \
    test -s /usr/share/nginx/html/libs/qrcode-local.js; \
    test -s /usr/share/nginx/html/libs/pako.min.js; \
    test -s /usr/share/nginx/html/libs/html5-qrcode.min.js; \
    cp /usr/share/nginx/html/libs/qrcode-local.js /usr/share/nginx/html/libs/qrcode.min.js

EXPOSE 80
