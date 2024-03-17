import { pathToFileURL } from 'node:url'
import { createUnplugin } from 'unplugin'
import { parseQuery, parseURL } from 'ufo'
import MagicString from 'magic-string'
import type { SourceMapInput } from 'rollup'
import type { Node } from 'estree-walker'
import { walk } from 'estree-walker'
import type { SimpleCallExpression } from 'estree'

export interface ScriptInjectOptions {
  resolveScript: (src: string) => string
}

/**
 * useScript('https://example.com/script.js', {
 *   assetStrategy: 'bundle',
 * })
 * ->
 * useScript('<inlined-script>')
 */
export function NuxtScriptTransformer(options: ScriptInjectOptions) {
  return createUnplugin(() => {
    return {
      name: 'nuxt:scripts:inline-script-transformer',
      enforce: 'post',

      transformInclude(id) {
        const { pathname, search } = parseURL(decodeURIComponent(pathToFileURL(id).href))
        const { type } = parseQuery(search)

        // vue files
        if (pathname.endsWith('.vue') && (type === 'script' || !search))
          return true

        // js files
        if (pathname.match(/\.((c|m)?j|t)sx?$/g))
          return true

        if (pathname.includes('node_modules/@unhead') || pathname.includes('node_modules/vueuse'))
          return false

        return false
      },

      async transform(code, id) {
        if (!code.includes('useScript'))
          return

        const ast = this.parse(code)
        const s = new MagicString(code)
        walk(ast as Node, {
          enter(_node) {
            if (
              _node.type === 'CallExpression'
              && _node.callee.type === 'Identifier'
              && _node.callee?.name === 'useScript') {
              const node = _node as SimpleCallExpression
              if (node.arguments[1].type !== 'ObjectExpression')
                return
              // second node needs to be an object with an property of assetStrategy and a value of 'bundle'
              const assetStrategyProperty = node.arguments[1].properties.find(
                (p: any) => p.key?.name === 'assetStrategy' || p.key?.value === 'assetStrategy',
              )
              if (assetStrategyProperty?.value?.value !== 'bundle')
                return
              // remove the property
              s.remove(assetStrategyProperty.start, assetStrategyProperty.end + 1) // need to strip the comma

              let scriptNode: any | undefined
              // do easy case first where first argument is a literal
              if (node.arguments[0].type === 'Literal') {
                scriptNode = node.arguments[0]
              }
              else if (node.arguments[0].type === 'ObjectExpression') {
                const srcProperty = node.arguments[0].properties.find(
                  (p: any) => p.key?.name === 'src' || p.key?.value === 'src',
                )
                scriptNode = srcProperty?.value
              }

              if (scriptNode) {
                const src = scriptNode.value
                if (src) {
                  const newSrc = options.resolveScript(src)
                  s.overwrite(scriptNode.start, scriptNode.end, `'${newSrc}'`)
                }
              }
            }
          },
        })

        if (s.hasChanged()) {
          return {
            code: s.toString(),
            map: s.generateMap({ includeContent: true, source: id }) as SourceMapInput,
          }
        }
      },
    }
  })
}