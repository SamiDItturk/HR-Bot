# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# no build step for ESM; if you have one, add it here

# --- runtime stage ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# install only prod deps
COPY --from=build /app /app
# ensure Node listens on all interfaces inside container
ENV PORT=8081
EXPOSE 8081
CMD ["node", "api/server.mjs"]
