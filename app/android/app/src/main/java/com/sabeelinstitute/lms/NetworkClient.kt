package com.sabeelinstitute.lms

import android.content.Context
import com.facebook.react.modules.network.OkHttpClientProvider
import java.util.concurrent.TimeUnit
import okhttp3.ConnectionPool
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * The HTTP client behind every JS `fetch` and XHR, and `expo/fetch`:
 * callables, Firestore's long polling, Firebase Auth and uploads. The same
 * file in all three Sabeel apps.
 *
 * React Native builds it with every timeout at 0 (infinite) and no HTTP/2 ping,
 * so a connection that dies silently holds every request to that host until
 * Android's TCP stack gives up, minutes later. On 2026-10-17 a Kanban label
 * delete sat 2.5 minutes that way: nothing reached the server, the SDK's own
 * 70s deadline fired without cancelling anything, and the whole backlog landed
 * at once when the connection finally broke.
 *
 * - The PING finds a dead HTTP/2 connection and OkHttp retries its calls on a
 *   fresh one. OkHttp fails the connection when a ping's pong has not come back
 *   by the next ping, so detection takes at most two intervals: 60s, inside the
 *   callable deadline.
 * - The CONNECT timeout moves a connect attempt into a dead route on to the
 *   host's next address.
 * - No read or call timeout: Firestore's long-poll requests stay open by design.
 *
 * Uploads are exempt from the ping: a Cloud Storage request (Kanban's
 * attachments) and any PUT (a part of a recording sent to a pre-signed URL,
 * in LMS). A ping queues behind upload bytes already sent, and Google's
 * servers allow 1 MiB in flight, so on an uplink too slow to move 1 MiB within
 * one interval (about 280 kbit/s at 30s) a healthy upload connection is
 * declared dead. Measured with OkHttp 4.9.2 against that window: a 2 MiB upload
 * at 200 kbit/s failed at 60s with the ping and succeeded in 85s without.
 * Storage does not retry a failed chunk, so the attachment would fail outright
 * where today it is merely slow.
 */
fun networkClient(context: Context): OkHttpClient {
  val base = OkHttpClientProvider.createClientBuilder(context)
    .connectTimeout(CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
    .build()
  // Shares the dispatcher, so React Native's cancel-by-tag still finds a
  // handed-off call, and the cookie jar. Its own pool, so no pinged connection
  // is ever reused for an upload.
  val uploads = base.newBuilder().connectionPool(ConnectionPool()).build()
  // React Native derives each request's client from this one with newBuilder(),
  // which keeps the interceptor.
  return base.newBuilder()
    .pingInterval(PING_INTERVAL_S, TimeUnit.SECONDS)
    .addInterceptor(UploadsWithoutPing(uploads))
    .build()
}

private const val CONNECT_TIMEOUT_S = 10L
private const val PING_INTERVAL_S = 30L

/** Cloud Storage's REST paths, on the production host and the emulator alike. */
private const val STORAGE_PATH_PREFIX = "/v0/b/"

private fun isUpload(request: Request): Boolean =
  request.method == "PUT" || request.url.encodedPath.startsWith(STORAGE_PATH_PREFIX)

private class UploadsWithoutPing(private val uploads: OkHttpClient) : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val request = chain.request()
    if (!isUpload(request)) return chain.proceed(request)
    val call = uploads.newCall(request)
    // An XHR timeout reaches OkHttp as the outer call's timeout; carry it over.
    call.timeout().timeout(chain.call().timeout().timeoutNanos(), TimeUnit.NANOSECONDS)
    return call.execute()
  }
}
