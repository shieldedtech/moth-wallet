// TabsList only renders true inside Tabs — full composition on purpose.
import { Tabs, TabsList, TabsTrigger } from '@shieldedtech/moth-extension';

export const ThreeTabs = () => (
  <Tabs defaultValue="all">
    <TabsList>
      <TabsTrigger value="all">All</TabsTrigger>
      <TabsTrigger value="sent">Sent</TabsTrigger>
      <TabsTrigger value="received">Received</TabsTrigger>
    </TabsList>
  </Tabs>
);
