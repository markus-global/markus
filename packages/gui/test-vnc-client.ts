import { VNCClient } from './src/vnc-client.js';
import { writeFileSync } from 'node:fs';

async function testVNCClient() {
  console.log('Testing VNC Client...');
  
  const client = new VNCClient({
    host: 'localhost',
    port: 5900,
    password: 'password' // Optional
  });

  client.on('connected', () => {
    console.log('✓ Connected to VNC server');
  });

  client.on('error', (err) => {
    console.error('✗ VNC error:', err);
  });

  client.on('frame', (frameBuffer) => {
    console.log(`✓ Frame received: ${frameBuffer.width}x${frameBuffer.height}, timestamp: ${new Date(frameBuffer.timestamp).toISOString()}`);
  });

  try {
    await client.connect();
    console.log('✓ Connection established');

    const screenInfo = client.getScreenInfo();
    if (screenInfo) {
      console.log('✓ Screen info:', {
        width: screenInfo.width,
        height: screenInfo.height,
        bitsPerPixel: screenInfo.bitsPerPixel,
        desktopName: 'Unknown'
      });
    }

    // Request screen update
    console.log('Requesting screen update...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Try to capture screen
    try {
      const screenData = await client.captureScreen();
      console.log(`✓ Screen captured: ${screenData.length} bytes`);
      
      // Save as raw RGBA data (for testing)
      writeFileSync('/tmp/vnc-screen.raw', screenData);
      console.log('✓ Screen data saved to /tmp/vnc-screen.raw');
    } catch (err) {
      console.log('No framebuffer available yet, waiting...');
    }

    // Test mouse movement
    console.log('Testing mouse movement...');
    await client.sendMouseMove(100, 100);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Test mouse click
    console.log('Testing mouse click...');
    await client.sendMouseClick(200, 200);
    
    // Test keyboard input
    console.log('Testing keyboard input...');
    await client.sendKeyPress(0x20, true); // Space key down
    await new Promise(resolve => setTimeout(resolve, 100));
    await client.sendKeyPress(0x20, false); // Space key up

    console.log('✓ All tests completed');
    
    // Keep connection open for a bit
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await client.disconnect();
    console.log('✓ Disconnected');
    
  } catch (err) {
    console.error('✗ Test failed:', err);
    process.exit(1);
  }
}

// Run test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testVNCClient().catch(console.error);
}

export { testVNCClient };