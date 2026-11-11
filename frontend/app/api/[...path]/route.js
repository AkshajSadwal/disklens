import { buildLocalApiTarget, isTrustedLocalProxyRequest } from "../../../lib/localApiProxy.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

async function proxy(request, context) {
  if (!isTrustedLocalProxyRequest(request)) {
    return Response.json({ error: "Untrusted local request origin." }, { status: 403 });
  }

  try {
    const params = await context.params;
    const target = buildLocalApiTarget(
      request.url,
      params?.path || [],
      process.env.DISKLENS_API_ORIGIN || "http://127.0.0.1:4000",
    );
    const headers = new Headers();
    for (const name of ["accept", "content-type", "if-none-match"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: request.signal,
    });

    const responseHeaders = new Headers();
    for (const name of ["content-type", "content-disposition", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("cache-control", "no-store");
    return new Response(method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return Response.json({
      error: "DiskLens local service is unavailable.",
      code: "LOCAL_API_UNAVAILABLE",
      message: process.env.NODE_ENV === "development" ? error.message : undefined,
    }, { status: 502 });
  }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
