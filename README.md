# HR Bot

## setup
1. create Postgres database `hrbot`, enable `pgvector` extension
2. run schema.sql to create tables
3. copy `.env.example` to `.env` and fill in credentials and keys
4. put HR documents (PDF/DOCX/TXT/MD) into `policies/`
5. run `node ingest.mjs` to load documents
6. run `node server.mjs` to start the orchestrator (port 8080)
7. host `widget/index.html` on https://chat.your-company.com/widget
8. embed in Oracle Fusion via Page Composer with an iFrame
