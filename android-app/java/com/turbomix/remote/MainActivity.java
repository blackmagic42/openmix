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
import java.util.Locale;

/**
 * Turbo Mix Remote — minimal app: a full-screen landscape WebView that
 * embeds the phone console served by the computer (port 8722). On first
 * launch (or if the computer is unreachable), it asks for the computer's IP address.
 */
public class MainActivity extends Activity {
  private WebView web;
  private SharedPreferences prefs;
  private boolean dialogOpen = false;

  // UI language: English by default, French when the phone is set to French
  private static final boolean FR = Locale.getDefault().getLanguage().equals("fr");

  private static String tr(String en, String fr) {
    return FR ? fr : en;
  }

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
        if (req.isForMainFrame()) askIp(tr("Computer unreachable — check the address (same WiFi as the computer)", "PC injoignable — vérifie l'adresse (même WiFi que le PC)"));
      }
    });
    setContentView(web);
    hideBars();

    String ip = prefs.getString("ip", null);
    if (ip == null) askIp(tr("Computer IP address (shown in OpenMix, ⚙ → Phone remote)", "Adresse IP du PC (affichée dans OpenMix, ⚙ → téléphone)"));
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
    input.setHint(tr("e.g. 192.168.1.20", "ex : 192.168.1.20"));
    input.setText(prefs.getString("ip", ""));
    new AlertDialog.Builder(this)
        .setTitle(title)
        .setView(input)
        .setCancelable(false)
        .setPositiveButton(tr("Connect", "Connecter"), (d, w) -> {
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
    // Back: long press = change IP, short press ignored (no web navigation)
    if (keyCode == KeyEvent.KEYCODE_BACK) {
      askIp(tr("Change the computer's IP address?", "Changer l'adresse IP du PC ?"));
      return true;
    }
    return super.onKeyDown(keyCode, event);
  }
}
