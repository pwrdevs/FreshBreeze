import { defineEventHandler, getRequestURL, sendRedirect } from 'h3'

const vercelProductionHostPattern = /^fresh-?breeze(?:-[a-z0-9-]+)?\.vercel\.app$/i
const fallbackOfficialOrigin = 'https://freshbreeze.pwrdevs.com'

export default defineEventHandler((event) => {
  if (process.env.VERCEL_ENV !== 'production') {
    return
  }

  const hostHeader = typeof event.node.req.headers.host === 'string'
    ? event.node.req.headers.host.trim().toLowerCase()
    : ''
  const requestHost = hostHeader.replace(/:\d+$/, '')

  if (!vercelProductionHostPattern.test(requestHost)) {
    return
  }

  const config = useRuntimeConfig(event)
  const officialOrigin = (config.appUrl || process.env.APP_URL || fallbackOfficialOrigin).replace(/\/+$/, '')
  const requestUrl = getRequestURL(event)
  const redirectUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, officialOrigin).toString()

  return sendRedirect(event, redirectUrl, 308)
})