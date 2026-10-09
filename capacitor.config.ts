import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.duaaps.scanner',
  appName: 'DUAAPS Scanner',
  webDir: 'www',
  server: {
    androidScheme: 'https',
    cleartext: true
  },
  plugins: {
    BarcodeScanner: {
      // Allows camera stream to show beneath webview
    }
  }
};

export default config;
