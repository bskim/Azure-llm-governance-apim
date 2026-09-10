metadata description = 'Private network for the governance control plane and the storage it depends on.'

@description('Base name used to derive resource names.')
@minLength(3)
@maxLength(12)
param name string

@description('Deployment environment discriminator.')
@minLength(1)
@maxLength(20)
param environmentName string

@description('Deployment location.')
param location string = resourceGroup().location

@description('Resource tags.')
param tags object = {}

@description('''Address space for the control plane network. It is never peered by this deployment, so it only has to avoid colliding with a network an operator later peers it to.''')
param addressPrefix string = '10.20.0.0/22'

@description('Subnet the function app integrates its outbound traffic into.')
param functionSubnetPrefix string = '10.20.0.0/24'

@description('Subnet holding the private endpoints the control plane resolves.')
param privateEndpointSubnetPrefix string = '10.20.1.0/24'

@description('''Private DNS zone name for the governance store. Azure exposes no environment suffix for Cosmos DB, so a sovereign cloud has to be told its zone rather than have one derived.''')
param governanceStorePrivateDnsZoneName string = 'privatelink.documents.azure.com'

@description('Private DNS zone that resolves the key store to its private address.')
param keyStorePrivateDnsZoneName string = 'privatelink.vaultcore.azure.net'

@description('''Ingress posture for the whole governance administration surface. public-authenticated leaves the console and the control plane addressable from the internet and gated by sign-in alone. private-only closes both and provisions the private endpoints and DNS zones that replace the public names, so administration is reachable only from this network. What that costs a deployment agent outside the network differs by resource: console assets still publish, because the restriction applies to incoming traffic to the website rather than to deployments of new site assets, whereas the control plane is published through the endpoint that has just become private and so needs a network path to it.''')
@allowed([
  'public-authenticated'
  'private-only'
])
param governanceAdministrationIngress string = 'public-authenticated'

@description('''Resource id of the administration console host. Read only when the administration surface is private, but required in both postures: the caller holds it either way, and a default would let a direct invocation reach the private branch with no host to attach the endpoint to.''')
@minLength(1)
param adminConsoleResourceId string

@description('''Default hostname the administration console host was issued. The zone that resolves it is derived from this rather than assumed, because Static Web Apps places a site in a regional partition and carries that partition in the name. Required in both postures, because an empty value derives the bare privatelink prefix and creates a zone that resolves nothing instead of failing the deployment.''')
@minLength(1)
param adminConsoleDefaultHostname string

@description('''Private DNS zone that resolves the control plane function app to its private address. Azure exposes no environment suffix for the app platform, so a sovereign cloud has to be told its zone rather than have one derived.''')
param controlPlanePrivateDnsZoneName string = 'privatelink.azurewebsites.net'

var vnetName = take('vnet-${name}-${environmentName}', 64)
var functionSubnetName = 'snet-functions'
var privateEndpointSubnetName = 'snet-private-endpoints'
var privateOnlyAdministration = governanceAdministrationIngress == 'private-only'
// A Static Web App is placed in a regional partition and the hostname carries it, so
// the zone is taken from the name the service actually issued. The unpartitioned form
// yields the plain zone from the same expression, which is why there is no second case.
var adminConsolePrivateDnsZoneName = 'privatelink.${join(skip(split(adminConsoleDefaultHostname, '.'), 1), '.')}'
var adminConsolePrivateEndpointName = take('pe-console-${name}-${environmentName}', 80)

// Zone names are derived from the cloud's storage suffix rather than hardcoded to
// the public cloud, because the name is what makes the private address win over
// the public one and a wrong name fails open to the public endpoint.
var privateDnsZoneNames = [
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.queue.${environment().suffixes.storage}'
  'privatelink.table.${environment().suffixes.storage}'
  governanceStorePrivateDnsZoneName
  keyStorePrivateDnsZoneName
]

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        addressPrefix
      ]
    }
  }
}

resource functionSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: virtualNetwork
  name: functionSubnetName
  properties: {
    addressPrefix: functionSubnetPrefix
    delegations: [
      {
        name: 'flex-consumption'
        properties: {
          serviceName: 'Microsoft.App/environments'
        }
      }
    ]
  }
}

// Subnets on one network cannot be written concurrently, so this one waits rather
// than racing the first and failing the deployment on a conflict.
resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: virtualNetwork
  name: privateEndpointSubnetName
  properties: {
    addressPrefix: privateEndpointSubnetPrefix
  }
  dependsOn: [
    functionSubnet
  ]
}

resource privateDnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for zoneName in privateDnsZoneNames: {
    name: zoneName
    location: 'global'
    tags: tags
  }
]

resource privateDnsZoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (zoneName, index) in privateDnsZoneNames: {
    parent: privateDnsZones[index]
    name: 'link-${vnetName}'
    location: 'global'
    tags: tags
    properties: {
      registrationEnabled: false
      virtualNetwork: {
        id: virtualNetwork.id
      }
    }
  }
]

// The administration zones are declared on their own rather than appended to the list
// above, because that list is addressed by index by every caller of this module and
// only exists when administration is private.
resource adminConsolePrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (privateOnlyAdministration) {
  name: adminConsolePrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource adminConsolePrivateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (privateOnlyAdministration) {
  parent: adminConsolePrivateDnsZone
  name: 'link-${vnetName}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

resource controlPlanePrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (privateOnlyAdministration) {
  name: controlPlanePrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource controlPlanePrivateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (privateOnlyAdministration) {
  parent: controlPlanePrivateDnsZone
  name: 'link-${vnetName}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

// The console endpoint is created here rather than beside the host, because the host is
// a global-content resource that may sit in a different region from this network and the
// endpoint has to be placed on the subnet this module owns.
resource adminConsolePrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateOnlyAdministration) {
  name: adminConsolePrivateEndpointName
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: 'staticSites'
        properties: {
          privateLinkServiceId: adminConsoleResourceId
          groupIds: [
            'staticSites'
          ]
        }
      }
    ]
  }
}

resource adminConsolePrivateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateOnlyAdministration) {
  parent: adminConsolePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'staticSites'
        properties: {
          privateDnsZoneId: adminConsolePrivateDnsZone.id
        }
      }
    ]
  }
}

output functionSubnetResourceId string = functionSubnet.id
output privateEndpointSubnetResourceId string = privateEndpointSubnet.id
output blobPrivateDnsZoneResourceId string = privateDnsZones[0].id
output queuePrivateDnsZoneResourceId string = privateDnsZones[1].id
output tablePrivateDnsZoneResourceId string = privateDnsZones[2].id
output governanceStorePrivateDnsZoneResourceId string = privateDnsZones[3].id
output keyStorePrivateDnsZoneResourceId string = privateDnsZones[4].id
output controlPlanePrivateDnsZoneResourceId string = privateOnlyAdministration ? controlPlanePrivateDnsZone.id : ''
output createdResourceIds array = concat(
  [
    virtualNetwork.id
    functionSubnet.id
    privateEndpointSubnet.id
  ],
  map(privateDnsZones, zone => zone.id),
  map(privateDnsZoneLinks, link => link.id),
  privateOnlyAdministration
    ? [
        adminConsolePrivateDnsZone.id
        adminConsolePrivateDnsZoneLink.id
        controlPlanePrivateDnsZone.id
        controlPlanePrivateDnsZoneLink.id
        adminConsolePrivateEndpoint.id
        adminConsolePrivateEndpointDns.id
      ]
    : []
)
