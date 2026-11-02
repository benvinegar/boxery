// extension.test.mjs loads extension/index.ts; pi is an optional peer dependency, not installed here.
declare module "@earendil-works/pi-coding-agent" {
	export type BashOperations = any;
	export type ExtensionAPI = any;
	export const createBashToolDefinition: any, createEditToolDefinition: any, createReadToolDefinition: any, createWriteToolDefinition: any;
}
