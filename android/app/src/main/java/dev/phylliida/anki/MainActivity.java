package dev.phylliida.anki;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(SaveFolderPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
