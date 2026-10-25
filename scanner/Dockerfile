# PM-OS competitors scanner — the Cloud Run job image.
#
# Node + Chromium (Playwright's image) running scripts/competitors-scanner.mts
# against the same Postgres and Vertex project as the app. Build from the repo
# root so the app's sources and Prisma schema are in context:
#
#   gcloud builds submit --tag us-east4-docker.pkg.dev/pm-os-9d992/pmos/competitors-scanner:latest -f scanner/Dockerfile .
#
# Runtime env (set on the job): DATABASE_URL or the Cloud SQL connector vars
# (INSTANCE_CONNECTION_NAME, DB_USER, DB_PASSWORD, DB_NAME), VERTEX_PROJECT_ID,
# COMPETITORS_BROWSER=on. Args: --scan <id> (from the app) or --due (scheduler).
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    COMPETITORS_BROWSER=on \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY scripts/competitors-scanner.mts scripts/ts-resolve-hooks.mjs ./scripts/
COPY tsconfig.json ./

# Node ≥ 23.6 strips TypeScript types natively; the hook resolves the app's
# extensionless relative imports. Playwright itself is a devDependency of the
# app, so the image installs it separately (the browsers come with the base image).
RUN npm install --no-save --no-audit --no-fund playwright@1.62.1

ENTRYPOINT ["node", "--no-warnings", "--import", "./scripts/ts-resolve-hooks.mjs", "scripts/competitors-scanner.mts"]
CMD ["--due"]
