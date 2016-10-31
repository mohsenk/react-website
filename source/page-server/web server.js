import koa from 'koa'

import render from './render'
import { get_preferred_locales } from './locale'
import render_stack_trace from './html stack trace'
import { normalize_common_options } from '../redux/normalize'

import start_monitoring from './monitoring'

export default function start_webpage_rendering_server(options, common)
{
	// In development mode errors are printed as HTML, for example
	const development = process.env.NODE_ENV !== 'production'

	// StatsD monitoring (optional)
	const monitoring = start_monitoring(options)

	common = normalize_common_options(common)

	const
	{
		assets,
		preload,
		localize,
		application,
		authentication,
		disable,
		loading,

		// Legacy 4.x API support
		head,
		body,
		body_start,
		body_end,
		style
	}
	= options

	const error_handler = options.catch

	// Legacy 4.x API support
	const html = options.html ||
	{
		head,
		body,
		body_start,
		body_end,
		style
	}

	const web = new koa()

	// Handles errors
	web.use(async (ctx, next) =>
	{
		// Trims a question mark in the end (just in case)
		const url = ctx.request.originalUrl.replace(/\?$/, '')

		monitoring.increment('request.count')
		monitoring.increment(`request.url.count.${url}`)

		const finished = monitoring.started('request')
		const finished_url = monitoring.started(`request.url.time.${url}`)

		try
		{
			await next()
		}
		catch (error)
		{
			monitoring.increment('requests.errors')

			// if the error is caught here it means that `catch` (`error_handler`) didn't resolve it
			// (or threw it)

			// show error stack trace in development mode for easier debugging
			if (development)
			{
				try
				{
					const { response_status, response_body } = render_stack_trace(error, options.print_error)

					if (response_body)
					{
						ctx.status = response_status || 500
						ctx.body = response_body
						ctx.type = 'html'

						return
					}
				}
				catch (error)
				{
					console.log('(couldn\'t render error stack trace)')
					console.log(error.stack || error)
				}
			}

			// log the error
			console.log('[react-isomorphic-render] Webpage rendering server error')

			if (options.log)
			{
				options.log.error(error)
			}

			ctx.status = typeof error.status === 'number' ? error.status : 500
			ctx.message = error.message || 'Internal error'
		}
		finally
		{
			finished()
			finished_url()
		}
	})

	// Custom Koa middleware extension point
	// (if someone ever needs this)
	if (options.middleware)
	{
		for (let middleware of options.middleware)
		{
			web.use(middleware)
		}
	}

	// Isomorphic rendering
	web.use(async (ctx) =>
	{
		// Trims a question mark in the end (just in case)
		const url = ctx.request.originalUrl.replace(/\?$/, '')

		monitoring.increment(`request.url.hits.${url}`)

		// Performs HTTP redirect
		const redirect_to = to => ctx.redirect(to)

		try
		{
			const { status, content, redirect } = await render
			({
				application,
				assets,
				preload,
				localize: localize ? (store) => localize(store, get_preferred_locales(ctx)) : undefined,
				disable,
				loading,
				html,
				authentication,

				// The original HTTP request can be required
				// for inspecting cookies in `preload` function
				request: ctx.req,

				// Cookies for authentication token retrieval
				cookies: ctx.cookies
			},
			common)

			if (redirect)
			{
				return redirect_to(redirect)
			}

			if (status)
			{
				ctx.status = status
			}

			ctx.body = content
		}
		catch (error)
		{
			monitoring.increment('requests.errors.handled')

			if (error_handler)
			{
				return error_handler(error,
				{
					url,
					redirect: redirect_to
				})
			}

			throw error
		}

		// This turned out to be a lame way to do it,
		// because cookies are sent in request 
		// with no additional parameters
		// such as `path`, `httpOnly` and `expires`,
		// so there were cookie duplication issues.
		//
		// Now superagent.agent() handles cookies correctly.
		//
		// ctx.set('set-cookie', _http_client.cookies)
	})

	return web
}