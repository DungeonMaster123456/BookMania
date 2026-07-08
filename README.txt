BookMania — quick start
========================

1. Install Node.js (v18+) if you don't have it.
2. Open a terminal in this folder and run:
     npm install
3. Start the server:
     npm start
   (or: node server.js)
4. Open http://localhost:3000 in your browser.

Owner/admin login:
  Email: owner@bookmania.local  (or set BOOKMANIA_OWNER_EMAIL)
  Code:  020501                 (or set BOOKMANIA_OWNER_PASSWORD)

Real email delivery (optional):
  Without setup, sign-in codes print to this terminal (dev mode) and
  are also shown in the browser so you can test right away.
  To send real emails, run: npm install nodemailer
  Then set these environment variables before starting the server:
     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM

Google Sign-In (optional):
  Create a free OAuth Client ID at https://console.cloud.google.com/apis/credentials
  (Web application, add your site's URL under Authorized JavaScript origins),
  then paste the Client ID into the GOOGLE_CLIENT_ID constant near the top of
  the <script> section in BookMania_socketio_live.html.
