import Stripe from 'stripe'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createError, defineEventHandler, getHeader, type H3Event } from 'h3'
import { config as loadDotenv } from 'dotenv'

const APP_KEY = 'freshbreeze'

type UserRole = 'admin' | 'worker'

interface AuthProfile {
  id: string
  role: UserRole
  active: boolean
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Unexpected Stripe checkout error.'
}

async function requireAdminUser(event: H3Event, adminClient: SupabaseClient): Promise<void> {
  const authorization = getHeader(event, 'authorization')
  const accessToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null

  if (!accessToken) {
    throw createError({ statusCode: 401, statusMessage: 'Missing authorization token.' })
  }

  const { data: requesterData, error: requesterError } = await adminClient.auth.getUser(accessToken)

  if (requesterError || !requesterData.user) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid authorization token.' })
  }

  const { data: requesterProfile, error: requesterProfileError } = await adminClient
    .from('profiles')
    .select('id, role, active')
    .eq('id', requesterData.user.id)
    .maybeSingle<AuthProfile>()

  if (requesterProfileError || !requesterProfile || !requesterProfile.active || requesterProfile.role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Only admins can access billing.' })
  }
}

// Ensure server routes can read local env files during development.
loadDotenv()
loadDotenv({ path: '.env.local', override: true })

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)

  const stripeSecretKey = config.stripeSecretKey || process.env.STRIPE_SECRET_KEY || ''
  const stripePriceId = config.stripePriceId?.trim() || process.env.STRIPE_PRICE_ID?.trim() || ''
  const appUrl = config.appUrl || process.env.APP_URL || ''

  console.info('[stripe/create-checkout] env diagnostics', {
    hasStripeSecretKey: Boolean(stripeSecretKey),
    hasStripePriceId: Boolean(stripePriceId),
    hasAppUrl: Boolean(appUrl),
    runtimeConfigHasStripePriceId: Boolean(config.stripePriceId),
    processEnvHasStripePriceId: Boolean(process.env.STRIPE_PRICE_ID),
    priceId: stripePriceId || null,
  })

  if (!stripeSecretKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'STRIPE_SECRET_KEY is not configured on the server.',
    })
  }

  if (!stripePriceId) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Stripe price configuration missing',
    })
  }

  console.info('[stripe/create-checkout] price id config', {
    hasPriceId: Boolean(stripePriceId),
    priceId: stripePriceId,
  })

  if (!appUrl) {
    throw createError({
      statusCode: 500,
      statusMessage: 'APP_URL is not configured on the server.',
    })
  }

  // Read app_subscription row
  const supabaseUrl = config.supabaseUrl || process.env.NUXT_PUBLIC_SUPABASE_URL || ''
  const supabaseServiceKey = config.supabaseServiceRoleKey || process.env.SUPABASE_SECRET_KEY || ''

  if (!supabaseUrl || !supabaseServiceKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Supabase server credentials are not configured.',
    })
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceKey)
  await requireAdminUser(event, adminClient)

  const { data: subscription, error: fetchError } = await adminClient
    .schema('public')
    .from('app_subscription')
    .select('id, stripe_customer_id')
    .eq('app_key', APP_KEY)
    .single()

  if (fetchError || !subscription) {
    throw createError({
      statusCode: 500,
      statusMessage: `Failed to read app_subscription: ${fetchError?.message ?? 'row not found'}`,
    })
  }

  const stripe = new Stripe(stripeSecretKey)
  const idempotencyKey = getHeader(event, 'x-idempotency-key') || undefined

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    line_items: [
      {
        price: stripePriceId,
        quantity: 1,
      },
    ],
    success_url: `${appUrl}/admin/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/admin/billing?checkout=cancelled`,
    metadata: {
      app_key: APP_KEY,
    },
  }

  // Attach existing Stripe customer if present
  if (subscription.stripe_customer_id) {
    sessionParams.customer = subscription.stripe_customer_id
  }

  console.info('[stripe/create-checkout] stripe request payload', {
    mode: sessionParams.mode,
    priceId: stripePriceId,
    quantity: sessionParams.line_items?.[0]?.quantity ?? null,
    hasCustomer: Boolean(sessionParams.customer),
    customerId: sessionParams.customer ?? null,
    successUrl: sessionParams.success_url,
    cancelUrl: sessionParams.cancel_url,
  })

  let session: Stripe.Checkout.Session

  try {
    session = await stripe.checkout.sessions.create(sessionParams, idempotencyKey ? { idempotencyKey } : undefined)
  }
  catch (error: unknown) {
    const stripeError = error instanceof Stripe.errors.StripeError ? error : null

    console.error('[stripe/create-checkout] stripe error', {
      message: getErrorMessage(error),
      type: stripeError?.type ?? null,
      code: stripeError?.code ?? null,
      param: stripeError?.param ?? null,
      statusCode: stripeError?.statusCode ?? null,
      requestId: stripeError?.requestId ?? null,
      declineCode: stripeError?.decline_code ?? null,
      charge: stripeError?.charge ?? null,
      docUrl: stripeError?.doc_url ?? null,
      raw: stripeError?.raw ?? null,
    })

    throw createError({
      statusCode: stripeError?.statusCode ?? 500,
      statusMessage: getErrorMessage(error),
    })
  }

  if (!session.url) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Stripe did not return a checkout URL. Please try again.',
    })
  }

  return { url: session.url }
})
