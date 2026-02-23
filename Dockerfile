FROM oven/bun:alpine
WORKDIR /app
COPY server.js .
COPY index.html .
EXPOSE 8080
CMD ["bun", "run", "server.js"]
