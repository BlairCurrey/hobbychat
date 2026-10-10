// Entry for the `<script src=".../client.js">` build: registers <hobby-chat>
// and exposes the headless client as `window.HobbyChat.connect`.
import { connect } from "./client.ts";
import { defineHobbyChat } from "./element.ts";

defineHobbyChat();
(globalThis as unknown as { HobbyChat: { connect: typeof connect } }).HobbyChat = { connect };
