FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
COPY assets ./assets
RUN chown -R node:node /app/assets
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
