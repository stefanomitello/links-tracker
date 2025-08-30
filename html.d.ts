declare module '*.html' {
	const content: string | (() => string);
	export default content;
}
