export default defineAppConfig({
  pages: ['pages/index/index', 'pages/search/index', 'pages/ask/index', 'pages/report/index'],
  window: {
    navigationBarTitleText: '邻至',
    navigationBarBackgroundColor: '#FFFFFF',
    navigationBarTextStyle: 'black',
    backgroundColor: '#F4F6F8',
  },
  lazyCodeLoading: 'requiredComponents',
  requiredPrivateInfos: ['getLocation', 'chooseLocation'],
  permission: {
    'scope.userLocation': { desc: '用你的位置作为体检中心（只在你点「用我的位置」时读取）' },
  },
});
