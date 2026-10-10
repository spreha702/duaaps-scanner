import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.duaaps.scanner',
  appName: 'DUAAPS Scanner',
  webDir: 'www',
  server: {
    androidScheme: 'https'
  }
};

export default config;
