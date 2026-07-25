package com.turbomix.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

/**
 * Turbo Mix Remote — app minimaliste : une WebView plein écran paysage qui
 * embarque la console téléphone servie par le PC (port 8722). Au premier
 * lancement (ou si le PC est injoignable), on demande l'adresse IP du PC.
 */
public class MainActivity extends Activity {
  private WebView web;
  private SharedPreferences prefs;
  private boolean dialogOpen = false;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    prefs = getSharedPreferences("turbomix", MODE_PRIVATE);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

    web = new WebView(this);
    web.setBackgroundColor(Color.parseColor("#0b0d12"));
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    web.setWebChromeClient(new WebChromeClient());
    web.setWebViewClient(new WebViewClient() {
      @Override
      public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
        if (req.isForMainFrame()) askIp("PC injoignable — vérifie l'adresse (même WiFi que le PC)");
      }
    });
    setContentView(web);
    hideBars();

    String ip = prefs.getString("ip", null);
    if (ip == null) askIp("Adresse IP du PC (affichée dans OpenMix, ⚙ → téléphone)");
    else load(ip);
  }

  private void load(String ip) {
    web.loadUrl("http://" + ip + ":8722");
  }

  private void askIp(String title) {
    if (dialogOpen) return;
    dialogOpen = true;
    final EditText input = new EditText(this);
    input.setInputType(InputType.TYPE_CLASS_TEXT);
    input.setHint("ex : 10.21.179.240");
    input.setText(prefs.getString("ip", "10.21.179.240"));
    new AlertDialog.Builder(this)
        .setTitle(title)
        .setView(input)
        .setCancelable(false)
        .setPositiveButton("Connecter", (d, w) -> {
          dialogOpen = false;
          String ip = input.getText().toString().trim();
          prefs.edit().putString("ip", ip).apply();
          load(ip);
        })
        .show();
  }

  private void hideBars() {
    web.setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideBars();
  }

  @Override
  public boolean onKeyDown(int keyCode, KeyEvent event) {
    // Retour : appui long = changer d'IP, appui court ignoré (pas de nav web)
    if (keyCode == KeyEvent.KEYCODE_BACK) {
      askIp("Changer l'adresse IP du PC ?");
      return true;
    }
    return super.onKeyDown(keyCode, event);
  }
}
