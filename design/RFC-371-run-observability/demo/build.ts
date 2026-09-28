// Reuse installed frontend dependencies. No package installation or production build.
const result = await Bun.build({
  entrypoints: [new URL('./app.tsx', import.meta.url).pathname],
  outdir: new URL('./build/', import.meta.url).pathname,
  target: 'browser',
  minify: true,
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"production"}',
  },
})
if (!result.success) {
  for (const entry of result.logs) console.error(entry)
  process.exit(1)
}
console.log('Built RFC-371 design demo.')
