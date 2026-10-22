package com.roarbyte.biva;

import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * A lost connection must not replace the saved business with the first-run page.
 * The service worker still has the screens, and the sign-in is on the phone.
 */
public class BivaWebViewClient extends BridgeWebViewClient {
    private int retries;

    public BivaWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame() && isOfflineError(error) && keepSavedApp(view, request)) return;
        super.onReceivedError(view, request, error);
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        if (request.isForMainFrame() && !hasNetwork(view) && keepSavedApp(view, request)) return;
        super.onReceivedHttpError(view, request, errorResponse);
    }

    private boolean keepSavedApp(WebView view, WebResourceRequest request) {
        String failed = request.getUrl() == null ? "" : request.getUrl().toString();
        if (!failed.contains("biva-dev-app.onrender.com")) return false;
        if (retries >= 2) return false;
        retries += 1;
        view.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
        String path = new BivaSessionBridge(view.getContext()).getPath();
        String next = path.isEmpty() ? failed : "https://biva-dev-app.onrender.com" + path;
        view.postDelayed(() -> {
            String current = view.getUrl() == null ? "" : view.getUrl();
            if (view.getProgress() == 100 && current.contains("biva-dev-app.onrender.com") && !current.contains("offline.html")) return;
            view.loadUrl(next);
        }, 700);
        return true;
    }

    private static boolean isOfflineError(WebResourceError error) {
        int code = error.getErrorCode();
        if (
            code == WebViewClient.ERROR_HOST_LOOKUP ||
            code == WebViewClient.ERROR_CONNECT ||
            code == WebViewClient.ERROR_IO ||
            code == WebViewClient.ERROR_TIMEOUT ||
            code == WebViewClient.ERROR_UNKNOWN
        ) {
            return true;
        }
        String description = error.getDescription() == null ? "" : error.getDescription().toString();
        return description.contains("ERR_INTERNET") || description.contains("ERR_NAME") || description.contains("ERR_CONNECTION") || description.contains("ERR_TIMED");
    }

    static boolean hasNetwork(WebView view) {
        ConnectivityManager manager = (ConnectivityManager) view.getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        if (manager == null) return true;
        Network network = manager.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities caps = manager.getNetworkCapabilities(network);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }
}
