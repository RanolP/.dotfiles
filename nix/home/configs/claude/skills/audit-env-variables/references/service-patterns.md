<overview>
Known service patterns for environment variable naming. Use these patterns to detect services and infer permission scopes.
</overview>

<database_services>
## Database Services

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `DATABASE_URL` | Generic DB | Critical | Full database access |
| `POSTGRES_*` | PostgreSQL | Critical | Database credentials |
| `MYSQL_*` | MySQL | Critical | Database credentials |
| `MONGODB_URI` | MongoDB | Critical | Full database access |
| `REDIS_URL` | Redis | High | Cache/session access |
| `SUPABASE_URL` | Supabase | Medium | Project URL (public) |
| `SUPABASE_ANON_KEY` | Supabase | Low | Public anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Critical | Bypasses RLS, full access |
| `PLANETSCALE_*` | PlanetScale | Critical | Database credentials |
| `TURSO_*` | Turso | Critical | Database credentials |
| `NEON_*` | Neon | Critical | Database credentials |
</database_services>

<authentication_services>
## Authentication Services

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `JWT_SECRET` | JWT | Critical | Token signing, full auth bypass if leaked |
| `SESSION_SECRET` | Sessions | Critical | Session forgery risk |
| `NEXTAUTH_SECRET` | NextAuth | Critical | Auth token signing |
| `NEXTAUTH_URL` | NextAuth | Low | Callback URL configuration |
| `AUTH0_*` | Auth0 | High | OAuth credentials |
| `CLERK_*` | Clerk | High | Auth service credentials |
| `KINDE_*` | Kinde | High | Auth service credentials |
| `OAUTH_*` | Generic OAuth | High | OAuth client credentials |
| `GOOGLE_CLIENT_ID` | Google OAuth | Medium | OAuth client ID (semi-public) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth | High | OAuth client secret |
| `GITHUB_CLIENT_*` | GitHub OAuth | High | OAuth credentials |
</authentication_services>

<payment_services>
## Payment Services

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `STRIPE_SECRET_KEY` | Stripe | Critical | Full account access, can charge cards |
| `STRIPE_PUBLISHABLE_KEY` | Stripe | Low | Public key for frontend |
| `STRIPE_WEBHOOK_SECRET` | Stripe | High | Webhook signature verification |
| `PAYPAL_*` | PayPal | Critical | Payment processing |
| `SQUARE_*` | Square | Critical | Payment processing |
| `LEMONSQUEEZY_*` | Lemon Squeezy | Critical | Payment/subscription |
| `PADDLE_*` | Paddle | Critical | Payment processing |
</payment_services>

<cloud_services>
## Cloud Services

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `AWS_ACCESS_KEY_ID` | AWS | Critical | Depends on IAM permissions |
| `AWS_SECRET_ACCESS_KEY` | AWS | Critical | Full credential |
| `AWS_REGION` | AWS | Low | Region configuration |
| `S3_BUCKET` | AWS S3 | Low | Bucket name only |
| `CLOUDFLARE_*` | Cloudflare | High | CDN/DNS control |
| `VERCEL_*` | Vercel | Medium | Deployment platform |
| `GCP_*` / `GOOGLE_*` | Google Cloud | Critical | Service account access |
| `AZURE_*` | Azure | Critical | Cloud credentials |
| `DO_*` / `DIGITALOCEAN_*` | DigitalOcean | Critical | Infrastructure access |
</cloud_services>

<email_services>
## Email Services

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `SENDGRID_API_KEY` | SendGrid | High | Can send emails as your domain |
| `MAILGUN_*` | Mailgun | High | Email sending |
| `RESEND_API_KEY` | Resend | High | Email sending |
| `POSTMARK_*` | Postmark | High | Email sending |
| `SMTP_*` | Generic SMTP | High | Email credentials |
| `EMAIL_SERVER_*` | Generic | High | SMTP configuration |
</email_services>

<storage_services>
## Storage Services

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `CLOUDINARY_*` | Cloudinary | Medium | Media storage |
| `UPLOADTHING_*` | UploadThing | Medium | File uploads |
| `IMAGEKIT_*` | ImageKit | Medium | Image CDN |
| `MINIO_*` | MinIO | High | S3-compatible storage |
</storage_services>

<analytics_monitoring>
## Analytics & Monitoring

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `SENTRY_DSN` | Sentry | Low | Error reporting (read-only) |
| `SENTRY_AUTH_TOKEN` | Sentry | Medium | Release management |
| `DATADOG_*` | Datadog | Medium | Monitoring |
| `NEW_RELIC_*` | New Relic | Medium | APM |
| `LOGTAIL_*` | Logtail | Low | Log aggregation |
| `AXIOM_*` | Axiom | Low | Log aggregation |
| `GA_*` / `GOOGLE_ANALYTICS_*` | Google Analytics | Low | Analytics tracking |
| `POSTHOG_*` | PostHog | Low | Product analytics |
| `MIXPANEL_*` | Mixpanel | Low | Analytics |
</analytics_monitoring>

<ai_services>
## AI/ML Services

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `OPENAI_API_KEY` | OpenAI | High | API usage, billing |
| `ANTHROPIC_API_KEY` | Anthropic | High | API usage, billing |
| `REPLICATE_*` | Replicate | High | Model inference |
| `HUGGINGFACE_*` | HuggingFace | Medium | Model access |
| `COHERE_*` | Cohere | High | API usage |
| `PINECONE_*` | Pinecone | Medium | Vector database |
| `WEAVIATE_*` | Weaviate | Medium | Vector database |
</ai_services>

<communication_services>
## Communication Services

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `TWILIO_*` | Twilio | High | SMS/Voice, can incur charges |
| `SLACK_*` | Slack | Medium | Workspace integration |
| `DISCORD_*` | Discord | Medium | Bot access |
| `PUSHER_*` | Pusher | Medium | Real-time messaging |
| `ABLY_*` | Ably | Medium | Real-time messaging |
</communication_services>

<cms_services>
## CMS & Content Services

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `CONTENTFUL_*` | Contentful | Medium | CMS access |
| `SANITY_*` | Sanity | Medium | CMS access |
| `STRAPI_*` | Strapi | High | Headless CMS |
| `PRISMIC_*` | Prismic | Medium | CMS access |
| `NOTION_*` | Notion | Medium | Workspace access |
</cms_services>

<application_config>
## Application Configuration

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `NODE_ENV` | Node.js | Low | Environment mode |
| `PORT` | Generic | Low | Server port |
| `HOST` / `HOSTNAME` | Generic | Low | Server host |
| `BASE_URL` / `APP_URL` | Generic | Low | Application URL |
| `API_URL` | Generic | Low | API endpoint |
| `DEBUG` | Generic | Low | Debug mode |
| `LOG_LEVEL` | Generic | Low | Logging configuration |
| `NEXT_PUBLIC_*` | Next.js | Low | Public client variables |
| `VITE_*` | Vite | Low | Public client variables |
</application_config>

<feature_flags>
## Feature Flags

| Pattern | Service | Permission Level | Notes |
|---------|---------|------------------|-------|
| `LAUNCHDARKLY_*` | LaunchDarkly | Medium | Feature flag service |
| `FLAGSMITH_*` | Flagsmith | Medium | Feature flags |
| `FEATURE_*` | Generic | Low | Custom feature toggles |
| `ENABLE_*` | Generic | Low | Feature enablement |
</feature_flags>

<permission_level_guide>
## Permission Level Guide

**Critical** - Immediate security risk if exposed:
- Can access/modify user data
- Can make financial transactions
- Can impersonate the application
- Requires immediate rotation if leaked

**High** - Significant security concern:
- Can send communications as the app
- Can access sensitive data
- May incur financial costs

**Medium** - Moderate access:
- Limited scope operations
- Specific service features
- Should still be protected

**Low** - Minimal risk:
- Public keys intended for client-side
- Configuration that's not sensitive
- Read-only or environment information
</permission_level_guide>
