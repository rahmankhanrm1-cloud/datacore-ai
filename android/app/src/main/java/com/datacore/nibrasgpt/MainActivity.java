package com.datacore.nibrasgpt;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.content.res.ColorStateList;
import android.widget.Button;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import android.util.Base64;
import android.webkit.WebResourceResponse;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.util.concurrent.Executors;
import android.os.Environment;
import android.os.Message;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final String HOME = "https://appassets.androidplatform.net/assets/index.html";
    private static final int FILE_REQUEST = 4370;
    private static final int SAVE_REQUEST = 4371;
    private byte[] pendingDownload;
    private static final String API_AUTH="https://datacore-ai-api.datacore-solutionswork.workers.dev/api/auth/google";
    private static final String GOOGLE_WEB_CLIENT="1021980839676-1ors7bt5kd27il5cs7c9q56725ikd91t.apps.googleusercontent.com";
    private String pendingSessionToken = null;
    private Button nativeGoogleButton;
    private WebView webView;
    private ProgressBar loading;
    private ValueCallback<Uri[]> upload;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(10,16,35));
        getWindow().setNavigationBarColor(Color.rgb(10,16,35));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(250,249,246));
        nativeGoogleButton=new Button(this);
        nativeGoogleButton.setText("Sign in with Google");
        nativeGoogleButton.setAllCaps(false);
        nativeGoogleButton.setTextColor(Color.rgb(20,80,84));
        nativeGoogleButton.setBackgroundTintList(ColorStateList.valueOf(Color.WHITE));
        nativeGoogleButton.setOnClickListener(v -> signInWithGoogle());
        root.addView(nativeGoogleButton,new LinearLayout.LayoutParams(-1,(int)(48*getResources().getDisplayMetrics().density)));
        loading = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loading.setMax(100);
        loading.setLayoutParams(new LinearLayout.LayoutParams(-1, 3));
        root.addView(loading);

        webView = new WebView(this);
        webView.setLayoutParams(new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(webView);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            settings.setSafeBrowsingEnabled(true);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "NibrasDownload",
                Collections.singleton("https://appassets.androidplatform.net"),
                (view, message, source, mainFrame, reply) -> {
                    if (mainFrame && isTrusted(Uri.parse(view.getUrl())) &&
                        "https://appassets.androidplatform.net".equals(source.toString())) {
                        saveBlob(message.getData());
                    }
                });
        }

        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!isTrusted(Uri.parse(url))) return;
                view.evaluateJavascript("(function(){if(document.getElementById('nibras-hide-google'))return;var style=document.createElement('style');style.id='nibras-hide-google';style.textContent='#googleBtnWrap{display:none!important}';document.head.appendChild(style);})();",null);
                installNativeSession();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request.isForMainFrame() && !isTrusted(request.getUrl())) {
                    openOutside(request.getUrl());
                    return true;
                }
                return false;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if (!isTrusted(uri)) { openOutside(uri); return true; }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int progress) {
                loading.setProgress(progress);
                loading.setVisibility(progress >= 100 ? View.GONE : View.VISIBLE);
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (upload != null) upload.onReceiveValue(null);
                upload = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, FILE_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    upload = null;
                    Toast.makeText(MainActivity.this, "No file picker found", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture,
                    Message resultMsg) {
                if (!userGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        openOutside(request.getUrl());
                        return true;
                    }
                    @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                        if (url != null && !url.equals("about:blank")) {
                            openOutside(Uri.parse(url));
                            v.stopLoading();
                        }
                    }
                });
                WebView.WebViewTransport t = (WebView.WebViewTransport)resultMsg.obj;
                t.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override public void onDownloadStart(String url, String ua,
                    String disposition, String mime, long length) {
                try {
                    Uri uri = Uri.parse(url);
                    if (!"https".equalsIgnoreCase(uri.getScheme())) {
                        Toast.makeText(MainActivity.this, "Use the browser to download this file", Toast.LENGTH_LONG).show();
                        return;
                    }
                    DownloadManager.Request req = new DownloadManager.Request(uri);
                    req.setMimeType(mime);
                    req.addRequestHeader("User-Agent", ua);
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    String name = android.webkit.URLUtil.guessFileName(url, disposition, mime);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    ((DownloadManager)getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
                    Toast.makeText(MainActivity.this, "Downloading to Downloads", Toast.LENGTH_SHORT).show();
                } catch (Exception ex) {
                    openOutside(Uri.parse(url));
                }
            }
        });

        if (state == null) webView.loadUrl(HOME);
        else webView.restoreState(state);
    }

    private void signInWithGoogle() {
        nativeGoogleButton.setEnabled(false);
        final GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(GOOGLE_WEB_CLIENT)
            .build();
        final GetCredentialRequest request=new GetCredentialRequest.Builder()
            .addCredentialOption(option).build();
        CredentialManager.create(this).getCredentialAsync(this,request,
            new CancellationSignal(),getMainExecutor(),
            new CredentialManagerCallback<GetCredentialResponse,GetCredentialException>() {
                @Override public void onResult(GetCredentialResponse result) {
                    Credential c=result.getCredential();
                    if (!(c instanceof CustomCredential) ||
                        !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(c.getType())) {
                        authError("Please select a Google account."); return;
                    }
                    try {
                        final String idToken=GoogleIdTokenCredential.createFrom(((CustomCredential)c).getData()).getIdToken();
                        exchangeGoogleToken(idToken);
                    } catch(Exception e) {authError("Google sign-in was not completed.");}
                }
                @Override public void onError(GetCredentialException e) {
                    authError("Google sign-in unavailable (" + e.getClass().getSimpleName() + "). Check Google Play Services and Android OAuth package/SHA-1 registration.");
                }
            });
    }
    private void exchangeGoogleToken(final String googleIdToken) {
        new Thread(() -> {
            HttpsURLConnection connection=null;
            try {
                connection=(HttpsURLConnection)new URL(API_AUTH).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(12000);
                connection.setReadTimeout(16000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type","application/json");
                connection.setRequestProperty("Accept","application/json");
                byte[] request=new JSONObject().put("credential",googleIdToken).toString().getBytes(StandardCharsets.UTF_8);
                try(OutputStream out=connection.getOutputStream()){out.write(request);}
                if(connection.getResponseCode()!=200)throw new IllegalStateException("Authentication declined");
                ByteArrayOutputStream buffer=new ByteArrayOutputStream();
                try(InputStream in=connection.getInputStream()){
                    byte[] temp=new byte[4096];int read;
                    while((read=in.read(temp))!=-1){if(buffer.size()>80000)throw new IllegalStateException("Invalid response");buffer.write(temp,0,read);}
                }
                JSONObject result=new JSONObject(buffer.toString(StandardCharsets.UTF_8.name()));
                if(!result.optBoolean("ok",false))throw new IllegalStateException("Authentication failed");
                String session=result.optString("token","");
                if(session.length()<20)throw new IllegalStateException("Invalid session");
                runOnUiThread(() -> {
                    pendingSessionToken=session;
                    nativeGoogleButton.setText("Sign in with Google");
                    nativeGoogleButton.setEnabled(true);
                    installNativeSession();
                });
            } catch(Exception e){authError("Google login could not be verified. Please use email sign-in or check the Google OAuth app configuration.");}
            finally{if(connection!=null)connection.disconnect();}
        }).start();
    }
    private void installNativeSession() {
        if(webView==null||pendingSessionToken==null||webView.getUrl()==null)return;
        if(!isTrusted(Uri.parse(webView.getUrl())))return;
        final String token=pendingSessionToken;
        pendingSessionToken=null;
        String js="(function(){if(location.origin !== 'https://appassets.androidplatform.net' || !location.pathname.startsWith('/assets/'))return;localStorage.setItem('datacore_v6_token',"+JSONObject.quote(token)+");window.location.reload();})();";
        webView.evaluateJavascript(js,null);
    }
    private void authError(final String message) {
        runOnUiThread(() -> {
            nativeGoogleButton.setEnabled(true);
            Toast.makeText(MainActivity.this,message,Toast.LENGTH_LONG).show();
        });
    }

    private boolean isTrusted(Uri uri) {
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        if (!"appassets.androidplatform.net".equalsIgnoreCase(uri.getHost())) return false;
        String path = uri.getPath();
        return path != null && path.startsWith("/assets/");
    }

    private void openOutside(Uri uri) {
        try {
            if ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme())) {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            }
        } catch (Exception e) {
            Toast.makeText(this, "Unable to open link", Toast.LENGTH_SHORT).show();
        }
    }

    private void saveBlob(String message) {
        if (pendingDownload != null || message == null || message.length() > 14000000) return;
        try {
            JSONObject payload = new JSONObject(message);
            String name = payload.getString("name");
            if (name.length() > 180 || name.contains("/") || name.contains("\\") || name.contains("\n")) throw new IllegalArgumentException();
            byte[] data = Base64.decode(payload.getString("data"), Base64.DEFAULT);
            if (data.length == 0 || data.length > 10000000) throw new IllegalArgumentException();
            pendingDownload = data;
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            save.addCategory(Intent.CATEGORY_OPENABLE);
            save.setType(payload.optString("mime", "application/octet-stream"));
            save.putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(save, SAVE_REQUEST);
        } catch (Exception e) {
            pendingDownload = null;
            Toast.makeText(this, "Unable to prepare this download", Toast.LENGTH_LONG).show();
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == SAVE_REQUEST) {
            byte[] bytes = pendingDownload;
            pendingDownload = null;
            if (result == RESULT_OK && data != null && data.getData() != null && bytes != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData(), "w")) {
                    if (out == null) throw new IllegalStateException();
                    out.write(bytes);
                    Toast.makeText(this, "File saved", Toast.LENGTH_SHORT).show();
                } catch (Exception e) { Toast.makeText(this, "File could not be saved", Toast.LENGTH_LONG).show(); }
            }
            return;
        }
        if (request == FILE_REQUEST && upload != null) {
            upload.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            upload = null;
        }
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        if (webView != null) webView.saveState(state);
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
