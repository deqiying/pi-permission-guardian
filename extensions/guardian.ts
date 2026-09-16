import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGuardian } from "../src/extension/register";

export default function guardianExtension(pi: ExtensionAPI): void {
  registerGuardian(pi);
}
