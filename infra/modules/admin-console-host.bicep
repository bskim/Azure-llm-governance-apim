metadata description = 'Static host for the governance administration interface.'

@description('Base name used to derive resource names.')
@minLength(3)
@maxLength(12)
param name string

@description('Deployment environment discriminator.')
@minLength(1)
@maxLength(20)
param environmentName string

@description('Location for the administrative interface. Static Web Apps is available in a limited set of regions.')
param location string = resourceGroup().location

@description('Resource tags.')
param tags object = {}

@description('''Ingress posture for the whole governance administration surface. public-authenticated leaves this host addressable from the internet and gated by sign-in alone. private-only closes it to the public network, so the site is reachable only through its private endpoint, which requires the private DNS zone and a network path to exist and leaves a browser outside that network unable to open the console. Publishing is unaffected: the restriction applies to incoming traffic to the website, not to deployments of new site assets, so a deployment agent outside the network can still publish content here.''')
@allowed([
  'public-authenticated'
  'private-only'
])
param governanceAdministrationIngress string = 'public-authenticated'

var resourceSuffix = take(uniqueString(subscription().id, resourceGroup().id, environmentName), 6)
var staticSiteName = take('stapp-${name}-${environmentName}-${resourceSuffix}', 60)
var administrationPublicNetworkAccess = governanceAdministrationIngress == 'private-only' ? 'Disabled' : 'Enabled'

// The administrative interface is static, so it is served as static content rather
// than by paying a function execution to return a file that never changes. It is
// provisioned ahead of the app registrations because its generated hostname is the
// only origin the console may sign in from, and a redirect URI cannot be guessed.
resource staticSite 'Microsoft.Web/staticSites@2024-04-01' = {
  name: staticSiteName
  location: location
  tags: union(tags, { 'azd-service-name': 'admin-console' })
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Disabled'
    publicNetworkAccess: administrationPublicNetworkAccess
  }
}

output staticSiteName string = staticSite.name
output staticSiteResourceId string = staticSite.id
output createdResourceIds array = [
  staticSite.id
]
// The origin stays the hostname the service issued in either posture. Closing the
// public network changes where that name resolves, not what it is called, so the
// sign-in redirect and the browser origin the control plane accepts are unchanged.
output defaultHostname string = staticSite.properties.defaultHostname
output origin string = 'https://${staticSite.properties.defaultHostname}'
