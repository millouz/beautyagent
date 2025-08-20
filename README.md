# BeautyAgent Server

This is a minimal Node.js/Express server for the BeautyAgent project. It integrates the [360dialog WhatsApp Business API](https://docs.360dialog.com) with the OpenAI API to qualify cosmetic surgery leads via WhatsApp.

The server receives incoming messages from 360dialog, forwards them to OpenAI for an AI‑generated response, and sends the response back to the user via 360dialog.

## Requirements

- [Node.js](https://nodejs.org/) v16 or newer
- A 360dialog WhatsApp Business API account with an API key
- An OpenAI API key (GPT‑3.5‑Turbo or GPT‑4 enabled)

## Setup

1. Clone this repository or copy the `beautyagent-server` folder to your machine.
2. Install dependencies:

   ```bash
   npm install
   ```
3. Create a `.env` file in the root of `beautyagent-server` and populate it based on `.env.example`:

   ```
   OPENAI_API_KEY=sk-xxxxx
   DIALOG_API_KEY=9f08a391-5e77-47f2-99a7-d34a87abdf28
   PORT=3000
   ```
4. Start the server:

   ```bash
   npm start
   ```

   The server will run on `http://localhost:3000` by default.

## Configure 360dialog

1. In your 360dialog hub, set the webhook URL to your deployed server endpoint (e.g. `https://api.beautyagent.fr/webhook`).
2. Ensure you have approved message templates for proactive messages (e.g. initial greetings, follow‑ups).
3. Incoming user messages will be forwarded to the `/webhook` endpoint and responded to automatically.

## Extending

The `index.js` file contains a simple example of how to call OpenAI and reply to users. You can customise the prompt, store conversation state, or implement more complex logic as needed. For example, you might:

- Log conversations to a database (Supabase, Airtable, etc.).
- Qualify leads based on specific criteria.
- Transfer hot leads to a human assistant via email or CRM.

## Deployment

To run this server in production, you can deploy it to any hosting provider that supports Node.js (Render, Railway, Vercel Serverless Functions, etc.). Ensure your environment variables are configured appropriately and that your server is reachable by 360dialog.