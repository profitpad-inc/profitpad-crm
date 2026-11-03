# Headless Chromium for render_view (api/src/render.ts). Runs a Playwright
# browser server; the API connects to it over the internal renderer network
# and drives it. Keep the version the same as playwright-core in api/.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
RUN npm install -g --no-audit --no-fund playwright@1.64.1
USER pwuser
EXPOSE 3000
CMD ["playwright", "run-server", "--port", "3000", "--host", "0.0.0.0"]
