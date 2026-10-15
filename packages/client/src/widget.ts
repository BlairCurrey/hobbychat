// `import "hobbychat/widget"` registers the <hobby-chat> element.
// When imported as a module, set the `server` attribute: there's no script tag to infer it from.
import { defineHobbyChat } from "./element.ts";

defineHobbyChat();

export { HobbyChatElement, defineHobbyChat } from "./element.ts";
