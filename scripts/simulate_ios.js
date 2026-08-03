import Bonjour from "bonjour-service";

const bonjour = new Bonjour();

console.log("Broadcasting fake iOS device on Bonjour network (_echomesh._tcp)...");

bonjour.publish({
  name: 'Deepak iPhone 15 Pro',
  type: 'echomesh',
  port: 8080,
  txt: {
    context: "https://developer.apple.com/documentation/multipeerconnectivity"
  }
});

console.log("Simulator running. Keep this script running in the background to test the Ambient Mesh feature.");
