# TradeArena - ein einziges Abbild fuer alles: API, WebSocket, Engine, Frontend.
#
# Node 24, weil SQLite dort ohne Zusatzflag eingebaut ist. Im Betrieb mit
# Postgres wird SQLite gar nicht geladen, aber so laeuft beides.

FROM node:24-alpine

WORKDIR /app

# Erst nur die Manifeste kopieren - so bleibt die npm-Schicht im Cache,
# solange sich die Abhaengigkeiten nicht aendern.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN npm install --no-audit --no-fund

COPY . .

# Frontend bauen - der Server liefert es danach selbst aus.
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Gesundheitscheck: der Dienst gilt als gesund, wenn /healthz antwortet.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["npm", "start"]
